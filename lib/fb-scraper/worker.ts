/**
 * Worker: cào page đối thủ rồi GHI vào Supabase (competitor_page/post/comment).
 * Chạy ở laptop bằng tsx (không phải Vercel). Dùng service_role qua createWorkerSupabase().
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createWorkerSupabase } from './supabase';
import { BlockedError, scrapeMany, type ScrapedPage } from './client';
import { launchStealth } from './browser';
import { linksFromPostPage, randomDelayMs } from './post-links';
import { scraperConfig } from './config';
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
      fail_count: 0, // cào lại được ⇒ xoá lịch sử lỗi, để lần hỏng sau đếm lại từ đầu
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
          caption_link_urls: p.linkUrls,
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
        author_id: c.authorId,
        author_name: c.authorName,
        is_page_author: c.isPageAuthor,
        message: c.message,
        // link_url giữ lại = link đầu tiên: UI/export cũ vẫn đọc cột này, đổi một lượt sẽ vỡ
        // mấy hàng cào từ trước.
        link_url: c.linkUrls[0] ?? null,
        link_urls: c.linkUrls,
        commented_at: toIso(c.createdAt),
        scraped_at: new Date().toISOString(),
      }));
      await db.from('competitor_comment').upsert(rows, { onConflict: 'competitor_post_id,fb_comment_id' });
      commentCount += rows.filter((r) => r.is_page_author).length;
    }
  }
  return commentCount;
}

// Đủ ngần này lượt lỗi TẠM THỜI liên tiếp thì cũng tắt (lỗi chặn thì tắt ngay, không đợi).
const MAX_FAILS = 3;

/**
 * Ghi lỗi + tự tắt page hỏng để lượt sau không phí timeout vào nó nữa.
 * Lỗi bị chặn (geo/audience/bot-detect) là xác định → tắt ngay. Lỗi tạm thời (timeout, mạng
 * chập) thì đếm, đủ MAX_FAILS lượt LIÊN TIẾP mới tắt — một lần rớt mạng không nên giết page.
 * Bật lại bằng nút "Bật" trên UI (sau khi mở VPN / đổi cookie).
 */
async function markError(db: SupabaseClient, pageRow: CompetitorPageRow, msg: string, blocked: boolean) {
  const fails = (pageRow.fail_count ?? 0) + 1;
  const off = blocked || fails >= MAX_FAILS;
  await db
    .from('competitor_page')
    .update({
      last_error: msg,
      last_scraped_at: new Date().toISOString(),
      fail_count: fails,
      ...(off ? { active: false } : {}),
    })
    .eq('id', pageRow.id);
  if (off) {
    console.warn(`  ↳ tắt theo dõi "${pageRow.handle}" (${blocked ? 'bị chặn' : `${fails} lượt lỗi liên tiếp`}) — bật lại trên UI`);
  }
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
        await markError(db, pageRow, res.error, res.blocked);
        return;
      }
      const n = await persist(db, pageRow, res);
      console.log(`✓ ${res.handle} (${res.pageName}): ${res.posts.length} post, ${n} comment của page`);
    },
  );
}

/**
 * Lượt 2: mở permalink từng bài để bóc link "full story" (feed không có link này — xem
 * post-links.ts). Chỉ đụng bài CẦN quét, có trần mỗi lượt, dừng cả lượt ngay khi bị chặn.
 *
 * Bài cần quét = chưa quét bao giờ, HOẶC còn mới (< postLinkRescanHours) mà vẫn chưa ra link —
 * đối thủ hay thả link vài giờ sau khi đăng. Bài cũ đã quét mà không có link thì bỏ hẳn, nếu
 * không mỗi lượt sẽ phí sạch trần vào mấy bài không bao giờ có link.
 */
export async function scrapePostLinks(
  db = createWorkerSupabase(),
): Promise<{ scanned: number; found: number; unreadable: number }> {
  const { postLinkLimit, postLinkRescanHours } = scraperConfig;
  const rescanCutoff = new Date(Date.now() - postLinkRescanHours * 3600_000).toISOString();

  // Hai query rời rồi gộp thay vì một .or(...) lồng and(): so sánh mảng rỗng trong PostgREST
  // (comment_link_urls.eq.{}) dùng đúng ký tự {} mà cú pháp .or() cũng dùng để gom nhóm — dễ
  // parse sai một cách âm thầm. Lọc "chưa có link" bằng JS thì nhìn là biết đúng.
  // handle đi kèm vì reel phải đổi sang URL /{handle}/videos/<id>/ mới đọc được comment
  // (xem readableUrl trong post-links.ts).
  // competitor_page nhúng vào là quan hệ MỘT-một, nhưng type sinh ra của Supabase khai là mảng —
  // nhận cả hai dạng rồi tự chuẩn hoá, khỏi ép kiểu bừa rồi vỡ lúc chạy.
  type Embedded = { handle: string } | { handle: string }[] | null;
  type Row = {
    id: string;
    permalink: string;
    links_scanned_at: string | null;
    comment_link_urls: string[];
    competitor_page: Embedded;
  };
  const handleOf = (e: Embedded): string | null => (Array.isArray(e) ? (e[0]?.handle ?? null) : (e?.handle ?? null));
  const cols = 'id, permalink, fb_created_at, links_scanned_at, comment_link_urls, competitor_page(handle)';

  const [fresh, recent] = await Promise.all([
    // Chưa quét bao giờ.
    db
      .from('competitor_post')
      .select(cols)
      .not('permalink', 'is', null)
      .is('links_scanned_at', null)
      .order('fb_created_at', { ascending: false, nullsFirst: false })
      .limit(postLinkLimit),
    // Còn mới: quét lại để bắt link đối thủ thả muộn (lọc "chưa ra link" ở dưới).
    db
      .from('competitor_post')
      .select(cols)
      .not('permalink', 'is', null)
      .not('links_scanned_at', 'is', null)
      .gte('fb_created_at', rescanCutoff)
      .order('fb_created_at', { ascending: false, nullsFirst: false })
      .limit(postLinkLimit),
  ]);
  if (fresh.error) throw new Error(`Đọc bài chưa quét link lỗi: ${fresh.error.message}`);
  if (recent.error) throw new Error(`Đọc bài cần quét lại lỗi: ${recent.error.message}`);

  const due = [
    ...((fresh.data ?? []) as Row[]),
    ...((recent.data ?? []) as Row[]).filter((r) => !(r.comment_link_urls ?? []).length),
  ].slice(0, postLinkLimit);
  if (!due.length) return { scanned: 0, found: 0, unreadable: 0 };

  console.log(`[link] mở permalink ${due.length} bài (trần ${postLinkLimit})...`);
  const { browser, context } = await launchStealth();
  let scanned = 0;
  let found = 0;
  let unreadable = 0;
  try {
    for (let i = 0; i < due.length; i++) {
      const p = due[i];
      try {
        const { links, rendered } = await linksFromPostPage(context, p.permalink, {
          handle: handleOf(p.competitor_page),
        });
        if (!rendered) {
          // Không đọc được bài (tường đăng nhập / trang lạ). Đánh dấu đã quét ở đây là khoá
          // vĩnh viễn một bài có thể đang có link — để nguyên cho lượt sau.
          unreadable++;
          console.warn(`[link] không đọc được ${p.permalink.slice(0, 60)} — bỏ qua, KHÔNG đánh dấu đã quét`);
        } else {
          await db
            .from('competitor_post')
            .update({ comment_link_urls: links, links_scanned_at: new Date().toISOString() })
            .eq('id', p.id);
          scanned++;
          if (links.length) found++;
        }
      } catch (e) {
        if (e instanceof BlockedError) {
          // Bị chặn = phiên đang bị soi. Cố thêm chỉ tổ đốt cookie đăng nhập -> dừng cả lượt,
          // lượt sau (6h nữa) chạy tiếp từ đúng chỗ vì links_scanned_at chưa được set.
          console.warn(`[link] bị chặn ở bài ${i + 1}/${due.length} — dừng lượt, giữ phiên đăng nhập`);
          break;
        }
        // Lỗi lẻ (timeout 1 bài) thì bỏ qua bài đó, KHÔNG đánh dấu đã quét để lượt sau thử lại.
        console.error(`[link] lỗi bài ${p.id}: ${(e as Error).message}`);
      }
      if (i < due.length - 1) await new Promise((r) => setTimeout(r, randomDelayMs()));
    }
  } finally {
    await browser.close();
  }
  console.log(`[link] quét ${scanned} bài, ${found} bài có link${unreadable ? `, ${unreadable} bài không đọc được` : ''}`);
  // Không đọc được HÀNG LOẠT gần như luôn là phiên đăng nhập hỏng chứ không phải bài lỗi lẻ —
  // nói thẳng ra, nếu không lượt nào cũng chạy không công mà nhìn log vẫn tưởng bình thường.
  if (unreadable > scanned && unreadable > 3) {
    console.warn(`[link] ⚠ phần lớn bài không đọc được — nhiều khả năng phiên FB đã rớt, chạy lại: npm run fb-login`);
  }
  return { scanned, found, unreadable };
}

/** Cào tất cả page active (cron 6h). */
export async function scrapeAllActive(db = createWorkerSupabase()): Promise<void> {
  const { data, error } = await db.from('competitor_page').select('*').eq('active', true);
  if (error) throw new Error(`Đọc competitor_page lỗi: ${error.message}`);
  const pages = (data ?? []) as CompetitorPageRow[];
  console.log(`[cron] cào ${pages.length} page active...`);
  await scrapePages(db, pages);
  // Lượt 2 chạy SAU khi feed xong: cần bài đã nằm trong DB mới biết permalink nào phải mở.
  // Lỗi ở đây không được kéo đổ cả lượt cào — dữ liệu feed đã ghi rồi.
  await scrapePostLinks(db).catch((e) => console.error('[link] lỗi:', (e as Error).message));
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
    await scrapePostLinks(db).catch((e) => console.error('[link] lỗi:', (e as Error).message));
  }
  return due.length;
}
