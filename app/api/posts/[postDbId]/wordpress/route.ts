import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { scrapeArticle } from "@/lib/scrape";
import { generateWpArticleFromFb, WpArticleGenError } from "@/lib/wp-article-gen";
import { wpEditPost, wpGetPostInfo } from "@/lib/wordpress/client";
import { getWpSiteForPost } from "@/lib/wordpress/site";
import { publishWpArticleForPost, resolveThumbnail, type ImageMode } from "@/lib/wp-publish";

export const runtime = "nodejs";
export const maxDuration = 60;

type SourceMode = "url" | "fb";

interface WpForm {
  mode: SourceMode;
  sourceUrl: string;
  title: string;
  contentHtml: string; // rỗng = "chưa sửa, dùng nội dung cào/sinh mới nhất" (chỉ áp dụng cho POST tạo mới)
  imageMode: ImageMode;
  imageUrl: string;
  imageFile: File | null;
  wpStatus: "draft" | "publish" | "";
}

async function parseWpForm(req: NextRequest): Promise<WpForm | NextResponse> {
  if (!req.headers.get("content-type")?.includes("multipart/form-data")) {
    let body: { sourceUrl?: string; title?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
    }
    return {
      mode: "url",
      sourceUrl: (body.sourceUrl ?? "").trim(),
      title: (body.title ?? "").trim(),
      contentHtml: "",
      imageMode: "auto",
      imageUrl: "",
      imageFile: null,
      wpStatus: "",
    };
  }
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ error: "Body form-data không hợp lệ" }, { status: 400 });
  }
  const mode = String(fd.get("mode") ?? "url");
  const imageMode = String(fd.get("imageMode") ?? "auto");
  const f = fd.get("imageFile");
  const status = String(fd.get("wpStatus") ?? "");
  return {
    mode: mode === "fb" ? "fb" : "url",
    sourceUrl: String(fd.get("sourceUrl") ?? "").trim(),
    title: String(fd.get("title") ?? "").trim(),
    contentHtml: String(fd.get("contentHtml") ?? "").trim(),
    imageMode: (["auto", "url", "none", "upload"] as const).includes(imageMode as ImageMode)
      ? (imageMode as ImageMode)
      : "auto",
    imageUrl: String(fd.get("imageUrl") ?? "").trim(),
    imageFile: f instanceof File ? f : null,
    wpStatus: status === "publish" ? "publish" : status === "draft" ? "draft" : "",
  };
}

// POST /api/posts/[postDbId]/wordpress — multipart/form-data { mode, sourceUrl, title, contentHtml?, imageMode, imageUrl?, imageFile?, wpStatus? }
// (vẫn nhận JSON { sourceUrl, title } cũ = mode "url", imageMode "auto", wpStatus "draft").
// 2 nguồn nội dung theo `mode`:
//   "url" — dán link bài gốc, cào (lib/scrape.ts).
//   "fb"  — sinh từ caption FB + Part 2 của chính post qua Gemini (lib/wp-article-gen.ts), không
//           cần sourceUrl (server tự lấy post.permalink làm nguồn).
// Rồi tạo bài WordPress (draft hoặc publish luôn) -> lưu scraped_article (1-1 với post) — phần này
// dùng chung qua lib/wp-publish.ts để 1 automation sau này gọi thẳng được, không qua HTTP.
export async function POST(req: NextRequest, { params }: { params: Promise<{ postDbId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postDbId } = await params;

  const form = await parseWpForm(req);
  if (form instanceof NextResponse) return form;
  const { mode, imageMode, wpStatus: statusInput } = form;
  const wpStatus: "draft" | "publish" = statusInput === "publish" ? "publish" : "draft";
  if (mode === "url" && !form.sourceUrl) {
    return NextResponse.json({ error: "Cần nhập link bài gốc" }, { status: 400 });
  }
  if (imageMode === "url" && !form.imageUrl) {
    return NextResponse.json({ error: "Thiếu link ảnh mới" }, { status: 400 });
  }
  if (imageMode === "upload") {
    if (!form.imageFile || !form.imageFile.type.startsWith("image/") || form.imageFile.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: "Ảnh không hợp lệ hoặc quá lớn" }, { status: 400 });
    }
  }

  const db = createSupabaseAdmin();
  const { data: post, error: postErr } = await db
    .from("post")
    .select("id, permalink")
    .eq("id", postDbId)
    .maybeSingle();
  if (postErr) return NextResponse.json({ error: postErr.message }, { status: 500 });
  if (!post) return NextResponse.json({ error: "Không tìm thấy post" }, { status: 404 });

  try {
    const article =
      mode === "fb" ? await generateWpArticleFromFb(db, postDbId) : await scrapeArticle(form.sourceUrl);
    const sourceUrl = mode === "fb" ? (post.permalink ?? "") : form.sourceUrl;

    const title = form.title || article.title || "(không tiêu đề)";
    // contentHtml: nếu user đã sửa ở bước preview thì dùng bản đã sửa, không thì dùng bản cào/sinh mới nhất.
    const contentHtml = form.contentHtml || article.contentHtml;

    const result = await publishWpArticleForPost(db, postDbId, {
      sourceUrl,
      title,
      contentHtml,
      excerpt: article.description,
      imageMode,
      imageUrl: form.imageUrl,
      imageFile: form.imageFile,
      autoImageUrl: article.imageUrl,
      wpStatus,
    });
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: 400 });

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof WpArticleGenError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

// PUT /api/posts/[postDbId]/wordpress — multipart/form-data { sourceUrl, title, contentHtml, imageMode, imageUrl?, imageFile?, wpStatus? }
// SỬA bài WP đã tồn tại (post đã có scraped_article.wp_post_id): dùng title/nội dung đã cào lại +
// sửa ở client, ghi đè lên bài WP hiện có. KHÔNG đổi slug/permalink đã có.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ postDbId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postDbId } = await params;

  const form = await parseWpForm(req);
  if (form instanceof NextResponse) return form;
  const { sourceUrl, title, contentHtml, imageMode } = form;
  if (!sourceUrl) return NextResponse.json({ error: "Cần nhập link bài gốc" }, { status: 400 });
  if (!title) return NextResponse.json({ error: "Tiêu đề không được trống" }, { status: 400 });
  if (!contentHtml) return NextResponse.json({ error: "Nội dung không được trống" }, { status: 400 });
  if (imageMode === "url" && !form.imageUrl) {
    return NextResponse.json({ error: "Thiếu link ảnh mới" }, { status: 400 });
  }
  if (imageMode === "upload") {
    if (!form.imageFile || !form.imageFile.type.startsWith("image/") || form.imageFile.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: "Ảnh không hợp lệ hoặc quá lớn" }, { status: 400 });
    }
  }

  const db = createSupabaseAdmin();
  const { data: row, error: rowErr } = await db
    .from("scraped_article")
    .select("wp_post_id, wp_status")
    .eq("post_id", postDbId)
    .maybeSingle();
  if (rowErr) return NextResponse.json({ error: rowErr.message }, { status: 500 });
  if (!row?.wp_post_id) return NextResponse.json({ error: "Post chưa có bài WP để sửa — tạo bài trước" }, { status: 404 });

  let site;
  try {
    site = await getWpSiteForPost(db, postDbId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    // "auto" khi sửa = giữ nguyên ảnh đại diện hiện có trên WP (không re-fetch từ nguồn).
    const thumb = await resolveThumbnail(site, {
      imageMode,
      imageUrl: form.imageUrl,
      imageFile: form.imageFile,
      removeSentinel: true,
    });
    if ("error" in thumb) return NextResponse.json({ error: thumb.error }, { status: 400 });

    const wpStatus: "draft" | "publish" = form.wpStatus === "publish" || form.wpStatus === "draft" ? form.wpStatus : (row.wp_status as "draft" | "publish") ?? "draft";

    const ok = await wpEditPost(site, row.wp_post_id, {
      title,
      contentHtml,
      thumbnailId: thumb.thumbnailId,
      categories: [site.category],
      status: wpStatus,
    });
    if (!ok) return NextResponse.json({ error: "WordPress từ chối cập nhật bài" }, { status: 502 });

    const base = site.baseUrl;
    const editUrl = base ? `${base}/wp-admin/post.php?post=${row.wp_post_id}&action=edit` : null;
    const { link, slug } = await wpGetPostInfo(site, row.wp_post_id);
    const prettyFromSlug = slug && base ? `${base}/${slug}/` : null;
    const permalink =
      (link && !link.includes("?p=") ? link : null) ?? prettyFromSlug ?? link ?? (base ? `${base}/?p=${row.wp_post_id}` : null);

    const { error: upErr } = await db
      .from("scraped_article")
      .update({
        source_url: sourceUrl,
        title,
        wp_status: wpStatus,
        wp_edit_url: editUrl,
        wp_permalink: permalink,
        updated_at: new Date().toISOString(),
      })
      .eq("post_id", postDbId);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, wpPostId: row.wp_post_id, editUrl, permalink });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
