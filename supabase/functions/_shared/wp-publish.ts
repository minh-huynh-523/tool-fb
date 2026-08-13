// Port của lib/wp-publish.ts cho Deno — chỉ giữ nhánh "auto" (Edge Function không có UI để user
// chọn url/upload/none — auto-publish luôn dùng ảnh tự động từ wp_content_queue.image_url).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getWpSiteForPost, wpGetPostInfo, wpNewPostDraft, wpUploadFile, type WpSite } from "./wordpress.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Best-effort: ảnh lỗi thì bỏ qua, KHÔNG chặn đăng bài (giống nhánh "auto" của bản Next.js).
async function resolveAutoThumbnail(site: WpSite, autoImageUrl: string | null): Promise<{ thumbnailId?: string }> {
  if (!autoImageUrl) return {};
  try {
    const imgRes = await fetch(autoImageUrl, { headers: { "User-Agent": UA } });
    if (imgRes.ok) {
      const buf = new Uint8Array(await imgRes.arrayBuffer());
      const type = imgRes.headers.get("content-type") ?? "image/jpeg";
      const name = autoImageUrl.split("/").pop()?.split("?")[0] || "featured.jpg";
      const up = await wpUploadFile(site, { name, type, bits: buf });
      if (up.id) return { thumbnailId: up.id };
    }
  } catch {
    // bỏ qua ảnh — auto là best-effort, giống bản Next.js
  }
  return {};
}

export interface PublishInput {
  sourceUrl: string;
  title: string;
  contentHtml: string;
  excerpt?: string;
  autoImageUrl?: string | null;
  wpStatus: "draft" | "publish";
}

export interface PublishResult {
  wpPostId: string;
  editUrl: string | null;
  permalink: string | null;
}

export async function publishWpArticleForPost(
  db: SupabaseClient,
  postDbId: string,
  input: PublishInput,
): Promise<PublishResult> {
  const site = await getWpSiteForPost(db, postDbId);
  const thumb = await resolveAutoThumbnail(site, input.autoImageUrl ?? null);

  const wpPostId = await wpNewPostDraft(site, {
    title: input.title,
    contentHtml: input.contentHtml,
    excerpt: input.excerpt,
    thumbnailId: thumb.thumbnailId,
    categories: [site.category],
    status: input.wpStatus,
  });
  const base = site.baseUrl;
  const editUrl = base ? `${base}/wp-admin/post.php?post=${wpPostId}&action=edit` : null;
  const { link, slug } = await wpGetPostInfo(site, wpPostId);
  const prettyFromSlug = slug && base ? `${base}/${slug}/` : null;
  const permalink =
    (link && !link.includes("?p=") ? link : null) ?? prettyFromSlug ?? link ?? (base ? `${base}/?p=${wpPostId}` : null);

  const { error: upErr } = await db.from("scraped_article").upsert(
    {
      post_id: postDbId,
      source_url: input.sourceUrl,
      title: input.title,
      wp_post_id: wpPostId,
      wp_status: input.wpStatus,
      wp_edit_url: editUrl,
      wp_permalink: permalink,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "post_id" },
  );
  if (upErr) throw new Error(upErr.message);

  return { wpPostId, editUrl, permalink };
}
