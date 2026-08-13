import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { wpGetPostInfo, wpNewPostDraft, wpUploadFile } from './wordpress/client';
import { getWpSiteForPost } from './wordpress/site';
import type { WpSite } from './wordpress/site';

// Tạo/đăng 1 bài WordPress cho 1 post, dùng CHUNG cho cả 2 nguồn nội dung: cào link ngoài
// (lib/scrape.ts) và sinh từ caption FB + Part 2 (lib/wp-article-gen.ts) — cả 2 trả về cùng shape
// { title, contentHtml, description, imageUrl, sourceUrl }. Tách khỏi route để sau này 1
// cron/automation (vd "auto đăng khi bài đủ comment + reaction") gọi thẳng được, không cần qua HTTP.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export type ImageMode = 'auto' | 'url' | 'none' | 'upload';

/**
 * Upload ảnh đại diện theo override của user (url/upload) hoặc ảnh nguồn tự động (auto).
 * removeSentinel: "none" khi sửa bài đã tồn tại phải trả "0" để CHỦ ĐỘNG gỡ ảnh trên WP;
 * lúc tạo bài mới thì "none" chỉ đơn giản là không set gì (bài chưa có ảnh để gỡ).
 */
export async function resolveThumbnail(
  site: WpSite,
  opts: {
    imageMode: ImageMode;
    imageUrl: string;
    imageFile: File | null;
    autoImageUrl?: string | null;
    removeSentinel?: boolean;
  },
): Promise<{ thumbnailId?: string } | { error: string }> {
  if (opts.imageMode === 'upload' && opts.imageFile) {
    try {
      const buf = Buffer.from(await opts.imageFile.arrayBuffer());
      const up = await wpUploadFile(site, {
        name: opts.imageFile.name || 'featured.jpg',
        type: opts.imageFile.type || 'image/jpeg',
        bits: buf,
      });
      if (!up.id) throw new Error('WordPress không trả attachment id');
      return { thumbnailId: up.id };
    } catch (e) {
      return { error: `Upload ảnh lên WordPress thất bại: ${(e as Error).message}` };
    }
  }
  if (opts.imageMode === 'url' && opts.imageUrl) {
    try {
      const imgRes = await fetch(opts.imageUrl, { headers: { 'User-Agent': UA }, cache: 'no-store' });
      const type = imgRes.headers.get('content-type') ?? '';
      if (!imgRes.ok || !type.startsWith('image/')) throw new Error('link không trả về ảnh');
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const name = opts.imageUrl.split('/').pop()?.split('?')[0] || 'featured.jpg';
      const up = await wpUploadFile(site, { name, type, bits: buf });
      if (!up.id) throw new Error('WordPress không trả attachment id');
      return { thumbnailId: up.id };
    } catch (e) {
      return { error: `Không tải được ảnh từ link đã dán: ${(e as Error).message}` };
    }
  }
  if (opts.imageMode === 'none') {
    return opts.removeSentinel ? { thumbnailId: '0' } : {};
  }
  if (opts.imageMode === 'auto' && opts.autoImageUrl) {
    try {
      const imgRes = await fetch(opts.autoImageUrl, { headers: { 'User-Agent': UA }, cache: 'no-store' });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const type = imgRes.headers.get('content-type') ?? 'image/jpeg';
        const name = opts.autoImageUrl.split('/').pop()?.split('?')[0] || 'featured.jpg';
        const up = await wpUploadFile(site, { name, type, bits: buf });
        if (up.id) return { thumbnailId: up.id };
      }
    } catch {
      // bỏ qua ảnh — auto là best-effort
    }
  }
  return {};
}

export interface PublishInput {
  sourceUrl: string;
  title: string;
  contentHtml: string;
  excerpt?: string;
  imageMode: ImageMode;
  imageUrl?: string;
  imageFile?: File | null;
  autoImageUrl?: string | null;
  wpStatus: 'draft' | 'publish';
}

export interface PublishResult {
  wpPostId: string;
  editUrl: string | null;
  permalink: string | null;
}

// Site đích -> resolve ảnh -> wp.newPost -> upsert scraped_article (1-1 với post). Dùng cho cả
// POST /api/posts/[postDbId]/wordpress (2 nguồn nội dung) lẫn 1 automation gọi thẳng sau này.
export async function publishWpArticleForPost(
  db: SupabaseClient,
  postDbId: string,
  input: PublishInput,
): Promise<PublishResult | { error: string }> {
  const site = await getWpSiteForPost(db, postDbId);

  const thumb = await resolveThumbnail(site, {
    imageMode: input.imageMode,
    imageUrl: input.imageUrl ?? '',
    imageFile: input.imageFile ?? null,
    autoImageUrl: input.autoImageUrl,
  });
  if ('error' in thumb) return { error: thumb.error };

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
  // Permalink pretty (dạng /slug/): bài publish lấy `link` từ WP; draft thì `link` là ?p=ID
  // -> dựng từ slug (đã set lúc tạo, giữ nguyên khi publish). Fallback cuối: ?p=.
  const { link, slug } = await wpGetPostInfo(site, wpPostId);
  const prettyFromSlug = slug && base ? `${base}/${slug}/` : null;
  const permalink =
    (link && !link.includes('?p=') ? link : null) ?? prettyFromSlug ?? link ?? (base ? `${base}/?p=${wpPostId}` : null);

  const { error: upErr } = await db.from('scraped_article').upsert(
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
    { onConflict: 'post_id' },
  );
  if (upErr) throw new Error(upErr.message);

  return { wpPostId, editUrl, permalink };
}
