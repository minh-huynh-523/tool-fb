import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { scrapeArticle } from "@/lib/scrape";
import { wpGetPostInfo, wpNewPostDraft, wpUploadFile } from "@/lib/wordpress/client";
import { getWpSiteForPost } from "@/lib/wordpress/site";

export const runtime = "nodejs";
export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

type ImageMode = "auto" | "url" | "none" | "upload";

// POST /api/posts/[postDbId]/wordpress — multipart/form-data { sourceUrl, title, imageMode, imageUrl?, imageFile?, wpStatus? }
// (vẫn nhận JSON { sourceUrl, title } cũ = imageMode "auto", wpStatus "draft").
// Cào bài gốc -> tạo bài WordPress (draft hoặc publish luôn) -> lưu scraped_article (1-1 với post).
export async function POST(req: NextRequest, { params }: { params: Promise<{ postDbId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postDbId } = await params;

  let sourceUrl = "";
  let titleOverride = ""; // title đã xác nhận/sửa ở bước 1
  let imageMode: ImageMode = "auto";
  let imageUrlOverride = "";
  let imageFile: File | null = null;
  let wpStatus: "draft" | "publish" = "draft";
  if (req.headers.get("content-type")?.includes("multipart/form-data")) {
    let fd: FormData;
    try {
      fd = await req.formData();
    } catch {
      return NextResponse.json({ error: "Body form-data không hợp lệ" }, { status: 400 });
    }
    sourceUrl = String(fd.get("sourceUrl") ?? "").trim();
    titleOverride = String(fd.get("title") ?? "").trim();
    const mode = String(fd.get("imageMode") ?? "auto");
    imageMode = (["auto", "url", "none", "upload"] as const).includes(mode as ImageMode)
      ? (mode as ImageMode)
      : "auto";
    imageUrlOverride = String(fd.get("imageUrl") ?? "").trim();
    const f = fd.get("imageFile");
    if (f instanceof File) imageFile = f;
    if (String(fd.get("wpStatus") ?? "") === "publish") wpStatus = "publish";
  } else {
    let body: { sourceUrl?: string; title?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
    }
    sourceUrl = (body.sourceUrl ?? "").trim();
    titleOverride = (body.title ?? "").trim();
  }
  if (!sourceUrl) return NextResponse.json({ error: "Cần nhập link bài gốc" }, { status: 400 });
  if (imageMode === "url" && !imageUrlOverride) {
    return NextResponse.json({ error: "Thiếu link ảnh mới" }, { status: 400 });
  }
  if (imageMode === "upload") {
    if (!imageFile || !imageFile.type.startsWith("image/") || imageFile.size > 8 * 1024 * 1024) {
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
    let thumbnailId: string | undefined;
    if (imageMode === "upload" && imageFile) {
      try {
        const buf = Buffer.from(await imageFile.arrayBuffer());
        const up = await wpUploadFile(site, {
          name: imageFile.name || "featured.jpg",
          type: imageFile.type || "image/jpeg",
          bits: buf,
        });
        if (!up.id) throw new Error("WordPress không trả attachment id");
        thumbnailId = up.id;
      } catch (e) {
        return NextResponse.json({ error: `Upload ảnh lên WordPress thất bại: ${(e as Error).message}` }, { status: 400 });
      }
    } else if (imageMode === "url") {
      try {
        const imgRes = await fetch(imageUrlOverride, { headers: { "User-Agent": UA }, cache: "no-store" });
        const type = imgRes.headers.get("content-type") ?? "";
        if (!imgRes.ok || !type.startsWith("image/")) throw new Error("link không trả về ảnh");
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const name = imageUrlOverride.split("/").pop()?.split("?")[0] || "featured.jpg";
        const up = await wpUploadFile(site, { name, type, bits: buf });
        if (!up.id) throw new Error("WordPress không trả attachment id");
        thumbnailId = up.id;
      } catch (e) {
        return NextResponse.json({ error: `Không tải được ảnh từ link đã dán: ${(e as Error).message}` }, { status: 400 });
      }
    } else if (imageMode === "auto" && article.imageUrl) {
      try {
        const imgRes = await fetch(article.imageUrl, { headers: { "User-Agent": UA }, cache: "no-store" });
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const type = imgRes.headers.get("content-type") ?? "image/jpeg";
          const name = article.imageUrl.split("/").pop()?.split("?")[0] || "featured.jpg";
          const up = await wpUploadFile(site, { name, type, bits: buf });
          if (up.id) thumbnailId = up.id;
        }
      } catch {
        // bỏ qua ảnh
      }
    }
    // imageMode === "none": không set thumbnail.

    const title = titleOverride || article.title || "(không tiêu đề)";
    const category = site.category;
    const wpPostId = await wpNewPostDraft(site, {
      title,
      contentHtml: article.contentHtml,
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
