// Port của lib/wp-publish.ts cho Deno — chỉ giữ nhánh "auto" (Edge Function không có UI để user
// chọn url/upload/none — auto-publish luôn dùng ảnh tự động từ wp_content_queue.image_url).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getWpSiteForPost, wpGetPostInfo, wpNewPostDraft, wpUploadFile, type WpSite } from "./wordpress.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Ảnh đại diện hẹp hơn ngưỡng này bị Rank Math loại khỏi og:image (Facebook cũng yêu cầu 200x200),
// nên link WP trong comment FB hiện logo site thay vì ảnh bài.
const MIN_WIDTH = 200;

// Đọc chiều rộng từ header JPEG/PNG. Đủ cho ảnh FB trả về; không kéo thêm thư viện chỉ để biết
// mỗi con số này.
function imageWidth(buf: Uint8Array): number | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return view.getUint32(16);
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return view.getUint16(i + 7);
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return null;
}

async function fetchImage(url: string): Promise<{ buf: Uint8Array; type: string; width: number | null } | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    console.log(`[wp-publish] fetch ${url} -> ${res.status} ${type || "?"}`);
    if (!res.ok || !type.startsWith("image/")) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return { buf, type, width: imageWidth(buf) };
  } catch (e) {
    console.error(`[wp-publish] fetch lỗi ${url}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Best-effort: ảnh lỗi thì bỏ qua, KHÔNG chặn đăng bài (giống nhánh "auto" của bản Next.js).
//
// Ảnh backup được chốt MỘT LẦN lúc bài còn là reel chưa đăng, khi Graph mới chỉ có `picture`
// (~160px). Bài đăng xong thì media_url là bản 405x720, nhưng mốc backup cũ khiến Storage đứng im.
// Nên ở đây đo ảnh backup, hẹp quá thì lấy thẳng media_url hiện tại của bài — đây là nơi cuối cùng
// quyết định ảnh lên WordPress, chặn ở đây thì không bài nào lọt ra với ảnh nhỏ nữa.
async function resolveAutoThumbnail(
  site: WpSite,
  autoImageUrl: string | null,
  liveMediaUrl: string | null,
): Promise<{ thumbnailId?: string; imageUrl?: string }> {
  let picked = autoImageUrl ? await fetchImage(autoImageUrl) : null;
  let pickedUrl = picked ? autoImageUrl : null;

  if ((!picked || (picked.width ?? 0) < MIN_WIDTH) && liveMediaUrl && liveMediaUrl !== autoImageUrl) {
    const live = await fetchImage(liveMediaUrl);
    if (live && (live.width ?? 0) > (picked?.width ?? 0)) {
      console.log(`[wp-publish] ảnh backup ${picked?.width ?? "?"}px quá nhỏ -> dùng media_url ${live.width}px`);
      picked = live;
      pickedUrl = liveMediaUrl;
    }
  }
  if (!picked || !pickedUrl) return {};

  const name = pickedUrl.split("/").pop()?.split("?")[0] || "featured.jpg";
  try {
    const up = await wpUploadFile(site, { name, type: picked.type, bits: picked.buf });
    console.log(`[wp-publish] wpUploadFile response id=${up.id} url=${up.url} width=${picked.width ?? "?"}`);
    if (up.id) return { thumbnailId: up.id, imageUrl: pickedUrl };
  } catch (e) {
    console.error(`[wp-publish] wpUploadFile error: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { imageUrl: pickedUrl };
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
  const { data: post } = await db.from("post").select("media_url").eq("id", postDbId).maybeSingle();
  const thumb = await resolveAutoThumbnail(site, input.autoImageUrl ?? null, post?.media_url ?? null);

  // If featured image upload failed (no thumbnailId) but we have an image URL,
  // embed the image into the post content as a fallback so the article still shows an image.
  let contentHtml = input.contentHtml;
  const fallbackImage = thumb.imageUrl ?? input.autoImageUrl;
  if (!thumb.thumbnailId && fallbackImage) {
    const safeAlt = (input.title || "").replace(/"/g, "&quot;");
    contentHtml = `<p><img src="${fallbackImage}" alt="${safeAlt}"/></p>\n\n${input.contentHtml}`;
  }

  const wpPostId = await wpNewPostDraft(site, {
    title: input.title,
    contentHtml,
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
