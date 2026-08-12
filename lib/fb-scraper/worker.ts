/**
 * Worker: cào page đối thủ rồi GHI vào Supabase (competitor_page/post/comment).
 * Chạy ở laptop bằng tsx (không phải Vercel). Dùng service_role qua createWorkerSupabase().
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createWorkerSupabase } from './supabase';
import { BlockedError, SessionExpiredError, scrapeMany, type ScrapedPage, type ScrapeManyOpts } from './client';
import { launchStealth } from './browser';
import { linksFromPostPage, randomDelayMs } from './post-links';
import { scraperConfig } from './config';
import type { ParsedComment } from './parse';
import type { CompetitorPageRow } from '../types';

const toIso = (unix: number | null) => (unix ? new Date(unix * 1000).toISOString() : null);

// Upsert comment vào 1 post đã có sẵn trong DB. Dùng chung cho lượt feed (persist()) và lượt mở
// permalink (scrapePostLinks()) — cùng khoá onConflict nên comment thấy ở cả 2 nơi tự merge,
// không tạo bản ghi trùng. Trả về số comment CHÍNH page (is_page_author) để log/đếm "Part 2".
async function persistComments(db: SupabaseClient, competitorPostId: string, comments: ParsedComment[]): Promise<number> {
  if (!comments.length) return 0;
  const rows = comments.map((c) => ({
    competitor_post_id: competitorPostId,
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
  return rows.filter((r) => r.is_page_author).length;
}

/**
 * Ghi trạng thái phiên FB (bảng singleton scraper_status, xem migration 0021) — GLOBAL, không
 * theo từng page, vì mọi page dùng chung 1 browser context/cookie. FE đọc để hiện banner cảnh báo
 * yêu cầu `npm run fb-login`. Gọi true ngay khi bắt SessionExpiredError; gọi false ngay khi bất kỳ
 * page nào cào thành công — tự lành, không cần dọn cờ tay sau khi đăng nhập lại.
 */
async function setScraperStatus(db: SupabaseClient, sessionExpired: boolean): Promise<void> {
  const patch: Record<string, unknown> = { session_expired: sessionExpired };
  if (sessionExpired) patch.session_expired_at = new Date().toISOString();
  else patch.last_ok_at = new Date().toISOString();
  const { error } = await db.from('scraper_status').update(patch).eq('key', 'global');
  if (error) console.error(`  ↳ KHÔNG ghi được scraper_status: ${error.message}`);
}

// Ghi 1 kết quả cào vào DB: cập nhật page + upsert post + upsert comment.
async function persist(db: SupabaseClient, pageRow: CompetitorPageRow, r: ScrapedPage): Promise<number> {
  // PHẢI xem error: câu update này từng hỏng ÂM THẦM suốt nhiều ngày vì thiếu cột `fail_count`
  // (migration 0011 chưa chạy) — PostgREST từ chối cả câu, nên last_scraped_at/last_error/name
  // đều không được ghi. UI hiện "chưa cào" cho page vừa cào xong 5 phút trước mà không ai biết
  // vì log im lặng. Cào vẫn chạy được nên đừng ném lỗi, chỉ cần LA LÊN.
  const { error: upErr } = await db
    .from('competitor_page')
    .update({
      name: r.pageName ?? pageRow.name,
      fb_page_id: r.fbPageId ?? pageRow.fb_page_id,
      last_scraped_at: new Date().toISOString(),
      last_error: null,
      fail_count: 0, // cào lại được ⇒ xoá lịch sử lỗi, để lần hỏng sau đếm lại từ đầu
    })
    .eq('id', pageRow.id);
  if (upErr) {
    console.error(`  ↳ KHÔNG ghi được trạng thái cào cho "${pageRow.handle}": ${upErr.message}`);
    console.error('    (thiếu cột? chạy migration còn thiếu trong supabase/migrations/)');
  }

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

    commentCount += await persistComments(db, postRow.id as string, p.comments);
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
  const { error: upErr } = await db
    .from('competitor_page')
    .update({
      last_error: msg,
      last_scraped_at: new Date().toISOString(),
      fail_count: fails,
      ...(off ? { active: false } : {}),
    })
    .eq('id', pageRow.id);
  // Cùng lý do với persist(): nuốt lỗi ở ĐÂY còn tệ hơn — mất luôn cả cơ chế tự tắt page hỏng,
  // page bị chặn sẽ được thử lại vô hạn mỗi lượt mà không để lại dấu vết nào.
  if (upErr) console.error(`  ↳ KHÔNG ghi được lỗi cào cho "${pageRow.handle}": ${upErr.message}`);
  if (off) {
    console.warn(`  ↳ tắt theo dõi "${pageRow.handle}" (${blocked ? 'bị chặn' : `${fails} lượt lỗi liên tiếp`}) — bật lại trên UI`);
  }
}

/**
 * Cào danh sách pageRow (cùng 1 browser), ghi DB. 1 page lỗi thường không chặn cả batch — RIÊNG
 * phiên FB hết hạn (SessionExpiredError) thì có, vì đó là lỗi của cả browser context dùng chung
 * (xem scrapeMany ở client.ts), không phải lỗi riêng của page đang cào.
 */
export async function scrapePages(
  db: SupabaseClient,
  pages: CompetitorPageRow[],
  opts: ScrapeManyOpts = {},
): Promise<void> {
  if (!pages.length) return;
  const byHandle = new Map(pages.map((p) => [p.handle, p]));
  await scrapeMany(
    pages.map((p) => p.handle),
    async (res) => {
      const pageRow = byHandle.get(res.handle);
      if (!pageRow) return;
      if ('error' in res) {
        console.error(`✗ ${res.handle}: ${res.error}`);
        if (res.sessionExpired) {
          // KHÔNG phải lỗi của riêng page này — đừng đốt fail_count/tắt page, chỉ báo phiên chết.
          await setScraperStatus(db, true);
          return;
        }
        await markError(db, pageRow, res.error, res.blocked);
        return;
      }
      const n = await persist(db, pageRow, res);
      await setScraperStatus(db, false); // cào được = bằng chứng sống phiên đang OK, tự dọn cờ cũ
      console.log(`✓ ${res.handle} (${res.pageName}): ${res.posts.length} post, ${n} comment của page`);
    },
    opts,
  );
}

/**
 * Lượt 2: mở permalink từng bài để bóc link "full story" + Part 2 comment (feed không có link này
 * — xem post-links.ts). Chỉ đụng bài CẦN quét, có trần mỗi lượt, dừng cả lượt ngay khi bị chặn.
 *
 * 3 nhóm bài "cần quét", gộp rồi dedupe theo id (ưu tiên đúng thứ tự dưới — bài chưa quét bao giờ
 * luôn được xử lý trước, backfill chỉ ăn phần trần còn dư):
 * 1. Chưa quét link bao giờ (links_scanned_at NULL).
 * 2. Còn mới (< postLinkRescanHours) mà vẫn chưa ra link — đối thủ hay thả link vài giờ sau khi
 *    đăng. Bài cũ đã quét mà không có link thì bỏ hẳn, nếu không mỗi lượt sẽ phí sạch trần vào
 *    mấy bài không bao giờ có link.
 * 3. Đã quét link (dù lâu rồi, dù đã ra link) nhưng CHƯA từng quét comment — backfill cho bài cào
 *    từ trước khi tính năng lấy Part 2 ở lượt này tồn tại (xem migration 0020).
 */
export async function scrapePostLinks(
  db = createWorkerSupabase(),
): Promise<{ scanned: number; found: number; unreadable: number; commentsAdded: number }> {
  const { postLinkLimit, postLinkRescanHours } = scraperConfig;
  const rescanCutoff = new Date(Date.now() - postLinkRescanHours * 3600_000).toISOString();

  // Hai query rời rồi gộp thay vì một .or(...) lồng and(): so sánh mảng rỗng trong PostgREST
  // (comment_link_urls.eq.{}) dùng đúng ký tự {} mà cú pháp .or() cũng dùng để gom nhóm — dễ
  // parse sai một cách âm thầm. Lọc "chưa có link" bằng JS thì nhìn là biết đúng.
  // handle đi kèm vì reel phải đổi sang URL /{handle}/videos/<id>/ mới đọc được comment
  // (xem readableUrl trong post-links.ts). fb_page_id đi kèm để lọc đúng isPageAuthor khi parse
  // comment từ permalink (xem persistComments + linksFromPostPage).
  // competitor_page nhúng vào là quan hệ MỘT-một, nhưng type sinh ra của Supabase khai là mảng —
  // nhận cả hai dạng rồi tự chuẩn hoá, khỏi ép kiểu bừa rồi vỡ lúc chạy.
  type Embedded = { handle: string; fb_page_id: string | null } | { handle: string; fb_page_id: string | null }[] | null;
  type Row = {
    id: string;
    fb_post_id: string;
    permalink: string;
    links_scanned_at: string | null;
    comments_scanned_at: string | null;
    comment_link_urls: string[];
    competitor_page: Embedded;
  };
  const handleOf = (e: Embedded): string | null => (Array.isArray(e) ? (e[0]?.handle ?? null) : (e?.handle ?? null));
  const pageIdOf = (e: Embedded): string | null =>
    (Array.isArray(e) ? (e[0]?.fb_page_id ?? null) : (e?.fb_page_id ?? null));
  const cols =
    'id, fb_post_id, permalink, fb_created_at, links_scanned_at, comments_scanned_at, comment_link_urls, competitor_page(handle, fb_page_id)';

  const [fresh, recent, commentBackfill] = await Promise.all([
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
    // Backfill: đã quét link (không quan tâm bao lâu / có ra link hay không) nhưng chưa từng quét
    // comment — bài cào trước khi tính năng Part 2 ở lượt này tồn tại. Xem migration 0020.
    db
      .from('competitor_post')
      .select(cols)
      .not('permalink', 'is', null)
      .not('links_scanned_at', 'is', null)
      .is('comments_scanned_at', null)
      .order('fb_created_at', { ascending: false, nullsFirst: false })
      .limit(postLinkLimit),
  ]);
  if (fresh.error) throw new Error(`Đọc bài chưa quét link lỗi: ${fresh.error.message}`);
  if (recent.error) throw new Error(`Đọc bài cần quét lại lỗi: ${recent.error.message}`);
  if (commentBackfill.error) throw new Error(`Đọc bài cần backfill comment lỗi: ${commentBackfill.error.message}`);

  // Gộp rồi dedupe theo id: 1 bài có thể vừa rơi vào "recent" (còn mới, chưa ra link) vừa vào
  // "commentBackfill" (chưa quét comment) — chỉ mở permalink 1 lần vẫn ăn được cả 2 việc.
  // Thứ tự đưa vào Map quyết định ưu tiên khi trần postLinkLimit chạm: fresh > recent > backfill,
  // để bài mới thật sự luôn được xử lý trước, backfill chỉ ăn phần trần còn dư mỗi lượt.
  const byId = new Map<string, Row>();
  for (const r of [
    ...((fresh.data ?? []) as Row[]),
    ...((recent.data ?? []) as Row[]).filter((r) => !(r.comment_link_urls ?? []).length),
    ...((commentBackfill.data ?? []) as Row[]),
  ]) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  const due = [...byId.values()].slice(0, postLinkLimit);
  if (!due.length) return { scanned: 0, found: 0, unreadable: 0, commentsAdded: 0 };

  console.log(`[link] mở permalink ${due.length} bài (trần ${postLinkLimit})...`);
  const { browser, context } = await launchStealth();
  let scanned = 0;
  let found = 0;
  let unreadable = 0;
  let commentsAdded = 0;
  try {
    for (let i = 0; i < due.length; i++) {
      const p = due[i];
      try {
        const { links, rendered, comments } = await linksFromPostPage(context, p.permalink, {
          handle: handleOf(p.competitor_page),
          fbPostId: p.fb_post_id,
          pageIdHint: pageIdOf(p.competitor_page),
        });
        if (!rendered) {
          // Không đọc được bài (tường đăng nhập / trang lạ). Đánh dấu đã quét ở đây là khoá
          // vĩnh viễn một bài có thể đang có link — để nguyên cho lượt sau.
          unreadable++;
          console.warn(`[link] không đọc được ${p.permalink.slice(0, 60)} — bỏ qua, KHÔNG đánh dấu đã quét`);
        } else {
          // Gộp với link đã có thay vì ghi đè: bài backfill có thể đã có comment_link_urls ổn định
          // từ lượt quét link trước — nếu lần đọc DOM này vì lý do gì đó (FB đổi layout, mạng chập)
          // ra ít link hơn thì vẫn không mất link cũ.
          const mergedLinks = [...new Set([...(p.comment_link_urls ?? []), ...links])];
          await db
            .from('competitor_post')
            .update({
              comment_link_urls: mergedLinks,
              links_scanned_at: new Date().toISOString(),
              comments_scanned_at: new Date().toISOString(),
            })
            .eq('id', p.id);
          scanned++;
          if (mergedLinks.length) found++;
          // Comment đọc được từ permalink đầy đủ hơn preview trong feed — upsert bổ sung, cùng
          // khoá onConflict với lượt feed nên comment thấy ở cả 2 nơi tự merge, không trùng.
          commentsAdded += await persistComments(db, p.id, comments);
          await setScraperStatus(db, false); // mở permalink thành công = phiên đang OK
        }
      } catch (e) {
        if (e instanceof SessionExpiredError) {
          // Phiên chết = chuyện của cả browser context, không phải riêng bài này — dừng cả lượt.
          await setScraperStatus(db, true);
          console.warn(`[link] phiên FB hết hạn ở bài ${i + 1}/${due.length} — dừng lượt: npm run fb-login`);
          break;
        }
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
  console.log(
    `[link] quét ${scanned} bài, ${found} bài có link, ${commentsAdded} comment bổ sung${unreadable ? `, ${unreadable} bài không đọc được` : ''}`,
  );
  // Không đọc được HÀNG LOẠT gần như luôn là phiên đăng nhập hỏng chứ không phải bài lỗi lẻ —
  // nói thẳng ra, nếu không lượt nào cũng chạy không công mà nhìn log vẫn tưởng bình thường.
  if (unreadable > scanned && unreadable > 3) {
    console.warn(`[link] ⚠ phần lớn bài không đọc được — nhiều khả năng phiên FB đã rớt, chạy lại: npm run fb-login`);
  }
  return { scanned, found, unreadable, commentsAdded };
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
    // Nút "Cào ngay" luôn lấy bài mới nhất trong 1 ngày, bất kể FB_SCRAPE_MAX_AGE_HOURS của cron.
    await scrapePages(db, due, { maxAgeHours: 24 });
    await scrapePostLinks(db).catch((e) => console.error('[link] lỗi:', (e as Error).message));
  }
  return due.length;
}
