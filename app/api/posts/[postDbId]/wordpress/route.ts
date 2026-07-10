import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { scrapeArticle } from "@/lib/scrape";
import { wpNewPostDraft, wpUploadFile } from "@/lib/wordpress/client";

export const runtime = "nodejs";
export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// POST /api/posts/[postDbId]/wordpress  { sourceUrl }
// Cào bài gốc -> tạo nháp WordPress -> lưu scraped_article (1-1 với post).
export async function POST(req: NextRequest, { params }: { params: Promise<{ postDbId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postDbId } = await params;

  let body: { sourceUrl?: string; title?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }
  const sourceUrl = (body.sourceUrl ?? "").trim();
  const titleOverride = (body.title ?? "").trim(); // title đã xác nhận/sửa ở bước 1
  if (!sourceUrl) return NextResponse.json({ error: "Cần nhập link bài gốc" }, { status: 400 });

  const db = createSupabaseAdmin();
  const { data: post, error: postErr } = await db.from("post").select("id").eq("id", postDbId).maybeSingle();
  if (postErr) return NextResponse.json({ error: postErr.message }, { status: 500 });
  if (!post) return NextResponse.json({ error: "Không tìm thấy post" }, { status: 404 });

  try {
    const article = await scrapeArticle(sourceUrl);

    // Ảnh đại diện (best-effort): tải ảnh -> upload -> set thumbnail. Lỗi ảnh thì vẫn đăng.
    let thumbnailId: string | undefined;
    if (article.imageUrl) {
      try {
        const imgRes = await fetch(article.imageUrl, { headers: { "User-Agent": UA }, cache: "no-store" });
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const type = imgRes.headers.get("content-type") ?? "image/jpeg";
          const name = article.imageUrl.split("/").pop()?.split("?")[0] || "featured.jpg";
          const up = await wpUploadFile({ name, type, bits: buf });
          if (up.id) thumbnailId = up.id;
        }
      } catch {
        // bỏ qua ảnh
      }
    }

    const title = titleOverride || article.title || "(không tiêu đề)";
    const category = process.env.WP_CATEGORY?.trim() || "Story";
    const wpPostId = await wpNewPostDraft({
      title,
      contentHtml: article.contentHtml,
      excerpt: article.description,
      thumbnailId,
      categories: [category],
    });
    const base = process.env.WP_BASE_URL ?? "";
    const editUrl = base ? `${base}/wp-admin/post.php?post=${wpPostId}&action=edit` : null;

    const { error: upErr } = await db.from("scraped_article").upsert(
      {
        post_id: postDbId,
        source_url: sourceUrl,
        title,
        wp_post_id: wpPostId,
        wp_status: "draft",
        wp_edit_url: editUrl,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "post_id" },
    );
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, wpPostId, editUrl });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
