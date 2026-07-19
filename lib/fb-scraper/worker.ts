/**
 * Worker: cào page đối thủ rồi GHI vào Supabase (competitor_page/post/comment).
 * Chạy ở laptop bằng tsx (không phải Vercel). Dùng service_role qua createWorkerSupabase().
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createWorkerSupabase } from './supabase';
import { scrapeMany, type ScrapedPage } from './client';
import type { CompetitorPageRow } from '../types';

const toIso = (unix: number | null) => (unix ? new Date(unix * 1000).toISOString() : null);

// Ghi 1 kết quả cào vào DB: cập nhật page + upsert post + upsert comment.
async function persist(db: SupabaseClient, pageRow: CompetitorPageRow, r: ScrapedPage): Promise<number> {
  await db
    .from('competitor_page')
    .update({
      name: r.pageName ?? pageRow.name,
      fb_page_id: r.fbPageId ?? pageRow.fb_page_id,
      last_scraped_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', pageRow.id);

  let commentCount = 0;
  for (const p of r.posts) {
    const { data: postRow, error } = await db
      .from('competitor_post')
      .upsert(
        {
          competitor_page_id: pageRow.id,
          fb_post_id: p.fbPostId,
          permalink: p.permalink,
          caption: p.caption,
          media_type: p.mediaType,
          media_url: p.mediaUrl,
          fb_created_at: toIso(p.createdAt),
          scraped_at: new Date().toISOString(),
        },
        { onConflict: 'competitor_page_id,fb_post_id' },
      )
      .select('id')
      .single();
    if (error || !postRow) continue;

    if (p.comments.length) {
      const rows = p.comments.map((c) => ({
        competitor_post_id: postRow.id as string,
        fb_comment_id: c.fbCommentId,
        author_name: c.authorName,
        message: c.message,
        link_url: c.linkUrl,
        commented_at: toIso(c.createdAt),
        scraped_at: new Date().toISOString(),
      }));
      await db.from('competitor_comment').upsert(rows, { onConflict: 'competitor_post_id,fb_comment_id' });
      commentCount += rows.length;
    }
  }
  return commentCount;
}

async function markError(db: SupabaseClient, pageId: string, msg: string) {
  await db.from('competitor_page').update({ last_error: msg, last_scraped_at: new Date().toISOString() }).eq('id', pageId);
}

/** Cào danh sách pageRow (cùng 1 browser), ghi DB. 1 page lỗi không chặn cả batch. */
export async function scrapePages(db: SupabaseClient, pages: CompetitorPageRow[]): Promise<void> {
  if (!pages.length) return;
  const byHandle = new Map(pages.map((p) => [p.handle, p]));
  await scrapeMany(
    pages.map((p) => p.handle),
    async (res) => {
      const pageRow = byHandle.get(res.handle);
      if (!pageRow) return;
      if ('error' in res) {
        console.error(`✗ ${res.handle}: ${res.error}`);
        await markError(db, pageRow.id, res.error);
        return;
      }
      const n = await persist(db, pageRow, res);
      console.log(`✓ ${res.handle} (${res.pageName}): ${res.posts.length} post, ${n} comment của page`);
    },
  );
}

/** Cào tất cả page active (cron 6h). */
export async function scrapeAllActive(db = createWorkerSupabase()): Promise<void> {
  const { data, error } = await db.from('competitor_page').select('*').eq('active', true);
  if (error) throw new Error(`Đọc competitor_page lỗi: ${error.message}`);
  const pages = (data ?? []) as CompetitorPageRow[];
  console.log(`[cron] cào ${pages.length} page active...`);
  await scrapePages(db, pages);
}

/** Xử lý đơn "Cào ngay" (nút trên Vercel set scrape_requested_at). Poll gọi hàm này. */
export async function processScrapeRequests(db = createWorkerSupabase()): Promise<number> {
  // Page có yêu cầu cào mới hơn lần cào gần nhất (hoặc chưa cào bao giờ).
  const { data, error } = await db
    .from('competitor_page')
    .select('*')
    .not('scrape_requested_at', 'is', null);
  if (error) throw new Error(`Đọc đơn cào lỗi: ${error.message}`);
  const due = (data ?? []).filter(
    (p: CompetitorPageRow) => !p.last_scraped_at || (p.scrape_requested_at && p.scrape_requested_at > p.last_scraped_at),
  ) as CompetitorPageRow[];
  if (due.length) {
    console.log(`[poll] ${due.length} đơn cào on-demand...`);
    await scrapePages(db, due);
  }
  return due.length;
}
