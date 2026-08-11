import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { scrapeArticle } from "@/lib/scrape";
import { wpEditPost, wpGetPostInfo, wpNewPostDraft, wpUploadFile } from "@/lib/wordpress/client";
import { getWpSiteForPost } from "@/lib/wordpress/site";
import type { WpSite } from "@/lib/wordpress/site";

export const runtime = "nodejs";
export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

type ImageMode = "auto" | "url" | "none" | "upload";

interface WpForm {
  sourceUrl: string;
  title: string;
  contentHtml: string; // rỗng = "chưa sửa, dùng nội dung cào mới nhất" (chỉ áp dụng cho POST tạo mới)
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
  const mode = String(fd.get("imageMode") ?? "auto");
  const f = fd.get("imageFile");
  const status = String(fd.get("wpStatus") ?? "");
  return {
    sourceUrl: String(fd.get("sourceUrl") ?? "").trim(),
    title: String(fd.get("title") ?? "").trim(),
    contentHtml: String(fd.get("contentHtml") ?? "").trim(),
    imageMode: (["auto", "url", "none", "upload"] as const).includes(mode as ImageMode) ? (mode as ImageMode) : "auto",
    imageUrl: String(fd.get("imageUrl") ?? "").trim(),
    imageFile: f instanceof File ? f : null,
    wpStatus: status === "publish" ? "publish" : status === "draft" ? "draft" : "",
  };
}

// Upload ảnh đại diện theo override của user (url/upload) hoặc ảnh cào tự động (auto).
// removeSentinel: "none" khi sửa bài đã tồn tại phải trả "0" để CHỦ ĐỘNG gỡ ảnh trên WP;
// lúc tạo bài mới thì "none" chỉ đơn giản là không set gì (bài chưa có ảnh để gỡ).
async function resolveThumbnail(
  site: WpSite,
  opts: { imageMode: ImageMode; imageUrl: string; imageFile: File | null; autoImageUrl?: string | null; removeSentinel?: boolean },
): Promise<{ thumbnailId?: string } | { error: string }> {
  if (opts.imageMode === "upload" && opts.imageFile) {
    try {
      const buf = Buffer.from(await opts.imageFile.arrayBuffer());
      const up = await wpUploadFile(site, {
        name: opts.imageFile.name || "featured.jpg",
        type: opts.imageFile.type || "image/jpeg",
        bits: buf,
      });
      if (!up.id) throw new Error("WordPress không trả attachment id");
      return { thumbnailId: up.id };
    } catch (e) {
      return { error: `Upload ảnh lên WordPress thất bại: ${(e as Error).message}` };
    }
  }
  if (opts.imageMode === "url" && opts.imageUrl) {
    try {
      const imgRes = await fetch(opts.imageUrl, { headers: { "User-Agent": UA }, cache: "no-store" });
      const type = imgRes.headers.get("content-type") ?? "";
      if (!imgRes.ok || !type.startsWith("image/")) throw new Error("link không trả về ảnh");
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const name = opts.imageUrl.split("/").pop()?.split("?")[0] || "featured.jpg";
      const up = await wpUploadFile(site, { name, type, bits: buf });
      if (!up.id) throw new Error("WordPress không trả attachment id");
      return { thumbnailId: up.id };
    } catch (e) {
      return { error: `Không tải được ảnh từ link đã dán: ${(e as Error).message}` };
    }
  }
  if (opts.imageMode === "none") {
    return opts.removeSentinel ? { thumbnailId: "0" } : {};
  }
  if (opts.imageMode === "auto" && opts.autoImageUrl) {
    try {
      const imgRes = await fetch(opts.autoImageUrl, { headers: { "User-Agent": UA }, cache: "no-store" });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const type = imgRes.headers.get("content-type") ?? "image/jpeg";
        const name = opts.autoImageUrl.split("/").pop()?.split("?")[0] || "featured.jpg";
        const up = await wpUploadFile(site, { name, type, bits: buf });
        if (up.id) return { thumbnailId: up.id };
      }
    } catch {
      // bỏ qua ảnh — auto là best-effort
    }
  }
  return {};
}

// POST /api/posts/[postDbId]/wordpress — multipart/form-data { sourceUrl, title, contentHtml?, imageMode, imageUrl?, imageFile?, wpStatus? }
// (vẫn nhận JSON { sourceUrl, title } cũ = imageMode "auto", wpStatus "draft").
// Cào bài gốc -> tạo bài WordPress (draft hoặc publish luôn) -> lưu scraped_article (1-1 với post).
export async function POST(req: NextRequest, { params }: { params: Promise<{ postDbId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postDbId } = await params;

  const form = await parseWpForm(req);
  if (form instanceof NextResponse) return form;
  const { sourceUrl, imageMode, wpStatus: statusInput } = form;
  const wpStatus: "draft" | "publish" = statusInput === "publish" ? "publish" : "draft";
  if (!sourceUrl) return NextResponse.json({ error: "Cần nhập link bài gốc" }, { status: 400 });
  if (imageMode === "url" && !form.imageUrl) {
    return NextResponse.json({ error: "Thiếu link ảnh mới" }, { status: 400 });
  }
  if (imageMode === "upload") {
    if (!form.imageFile || !form.imageFile.type.startsWith("image/") || form.imageFile.size > 8 * 1024 * 1024) {
      return NextResponse.json({ error: "Ảnh không hợp lệ hoặc quá lớn" }, { status: 400 });
    }
  }

  const db = createSupabaseAdmin();
  const { data: post, error: postErr } = await db.from("post").select("id").eq("id", postDbId).maybeSingle();
  if (postErr) return NextResponse.json({ error: postErr.message }, { status: 500 });
  if (!post) return NextResponse.json({ error: "Không tìm thấy post" }, { status: 404 });

  // Site WP đích lấy theo page của post (mỗi page 1 site); lỗi ở đây là lỗi cấu hình -> 400.
  let site;
  try {
    site = await getWpSiteForPost(db, postDbId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  try {
    const article = await scrapeArticle(sourceUrl);

    // Ảnh đại diện. User chọn ảnh chủ đích (url/upload) -> lỗi ảnh phải chặn đăng (400);
    // nhánh "auto" (ảnh cào về) giữ best-effort như cũ: lỗi ảnh vẫn đăng.
    const thumb = await resolveThumbnail(site, {
      imageMode,
      imageUrl: form.imageUrl,
      imageFile: form.imageFile,
      autoImageUrl: article.imageUrl,
    });
    if ("error" in thumb) return NextResponse.json({ error: thumb.error }, { status: 400 });
    const thumbnailId = thumb.thumbnailId;

    const title = form.title || article.title || "(không tiêu đề)";
    // contentHtml: nếu user đã sửa ở bước preview thì dùng bản đã sửa, không thì dùng bản cào mới nhất.
    const contentHtml = form.contentHtml || article.contentHtml;
    const category = site.category;
    const wpPostId = await wpNewPostDraft(site, {
      title,
      contentHtml,
      excerpt: article.description,
      thumbnailId,
      categories: [category],
      status: wpStatus,
    });
    const base = site.baseUrl;
    const editUrl = base ? `${base}/wp-admin/post.php?post=${wpPostId}&action=edit` : null;
    // Permalink pretty (dạng /slug/): bài publish lấy `link` từ WP; draft thì `link` là ?p=ID
    // -> dựng từ slug (đã set lúc tạo, giữ nguyên khi publish). Fallback cuối: ?p=.
    const { link, slug } = await wpGetPostInfo(site, wpPostId);
    const prettyFromSlug = slug && base ? `${base}/${slug}/` : null;
    const permalink =
      (link && !link.includes("?p=") ? link : null) ?? prettyFromSlug ?? link ?? (base ? `${base}/?p=${wpPostId}` : null);

    const { error: upErr } = await db.from("scraped_article").upsert(
      {
        post_id: postDbId,
        source_url: sourceUrl,
        title,
        wp_post_id: wpPostId,
        wp_status: wpStatus,
        wp_edit_url: editUrl,
        wp_permalink: permalink,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "post_id" },
    );
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, wpPostId, editUrl, permalink });
  } catch (e) {
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
