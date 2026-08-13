import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdmin } from './supabase/admin';
import { hourTodayVNISO } from './date';
import { generateWpArticleFromFb, WpArticleGenError } from './wp-article-gen';
import { publishWpArticleForPost } from './wp-publish';
import { drainOne } from './comments';

// Auto-publish: bài đủ ngưỡng (comment thật >= N HOẶC reaction_count >= N) tự sinh bài WP (Gemini)
// + tự đăng + tự comment link "Full story" vào bài FB gốc — không cần bấm tay (xem migration 0024).
//
// 2 hàng đợi TÁCH RỜI thay vì xử lý gộp 1 lượt — 1 lượt Gemini tốn tiền không phải làm lại chỉ vì
// bước đăng WP/comment hỏng, và ngược lại:
//   wp_content_queue — Stage 2, sinh nội dung qua Gemini
//   wp_publish_queue — Stage 3, đăng WordPress + comment FB
// Cùng pattern claim/PROCESSING/stale-reclaim với scheduled_comment (lib/comments.ts) — copy
// thẳng shape đó cho từng hàng đợi, không trừu tượng hoá chung.
//
// CÁC HÀM Ở FILE NÀY vẫn là nguồn "chạy tay" (nút "Chạy auto-publish ngay" ở /prompts, xem
// app/api/auto-publish/run) + fallback debug (app/api/cron/wp-content, wp-publish). Đường CHÍNH
// chạy định kỳ đã chuyển sang Supabase Edge Functions (supabase/functions/wp-content, wp-publish)
// + pg_cron ngay trong Supabase (migration 0025) — KHÔNG còn tốn quota Vercel. 2 bản logic (đây
// và supabase/functions/_shared/*) là 2 bản PORT riêng (Node vs Deno) — sửa 1 bên nhớ soi bên kia.

const STALE_MS = 120_000;
// Lỗi thì quay lại PENDING (không đứng yên ở FAILED) để lượt cron sau tự thử lại — cùng ý tưởng
// "PENDING + attempts>0 = đang chờ thử lại" mà scheduled_comment/StatusBadge đã dùng. Hết
// MAX_ATTEMPTS lượt mới đứng yên ở FAILED (cần người bấm "Thử lại" ở /posts hoặc /wp-needed).
const MAX_ATTEMPTS = 3;

// Cửa sổ bài được xét: TỪ giờ cắt (mặc định 12h trưa) CỦA HÔM NAY (giờ VN) ĐẾN HIỆN TẠI — quét
// THEO NGÀY thay vì tuổi bài rolling: không cần đợi bài "già" 1-2 ngày mới xét, và tự động không
// đụng lại bài hôm qua (qua nửa đêm VN, "hôm nay" tự đổi mốc theo hourTodayVNISO). Giờ cắt chỉnh
// được qua env.
function todaySinceCutoff(): { fromIso: string; toIso: string } {
  const cutoffHour = Number(process.env.AUTO_PUBLISH_CUTOFF_HOUR ?? 12);
  return { fromIso: hourTodayVNISO(cutoffHour), toIso: new Date().toISOString() };
}

// Ngưỡng "bài đủ hot" riêng cho auto-publish — TÁCH khỏi WP_ATTENTION_* (lib/attention.ts, dùng
// cho hàng đợi thủ công /wp-needed): auto-publish tự ĐĂNG THẬT lên WP nên cần chỉnh độc lập,
// không kéo theo đổi ngưỡng của /wp-needed. OR (không phải AND) — cùng dạng ngưỡng với
// needsWpOrFilter() ở /wp-needed. reaction hoặc comment thật (đã trừ first comment của page),
// mỗi vế TỪ số này trở lên (>=).
function autoPublishThresholds(): { minReactions: number; minComments: number } {
  const minReactions = Number(process.env.AUTO_PUBLISH_MIN_REACTIONS ?? 8);
  const minComments = Number(process.env.AUTO_PUBLISH_MIN_COMMENTS ?? 2);
  return { minReactions, minComments };
}

// ============================================================
// Stage 1 — phát hiện bài đủ ngưỡng, đẩy vào wp_content_queue. RẺ (không gọi API ngoài) — gọi
// trong cron sync-pages, ngay sau khi comment_count/reaction_count vừa được đồng bộ mới.
// ============================================================

interface Candidate {
  id: string;
  comment_count: number | null;
  reaction_count: number | null;
  page_commented: boolean;
  media_url: string | null;
  image_backup_at: string | null;
}

export async function enqueueWpContentCandidates(
  db: SupabaseClient = createSupabaseAdmin(),
  // Override cửa sổ thời gian — dùng để backfill 1 ngày cụ thể trong quá khứ (vd bấm tay ở
  // /prompts chọn ngày) mà vẫn CÙNG NGƯỠNG reaction/comment với đường chạy tự động thường ngày.
  // Bỏ trống -> mặc định todaySinceCutoff() như cron vẫn chạy.
  window?: { fromIso: string; toIso: string },
): Promise<{ enqueued: number }> {
  const { minReactions, minComments } = autoPublishThresholds();
  const { fromIso, toIso } = window ?? todaySinceCutoff();

  // Cùng idiom anti-join với countPostsNeedingWp (lib/queries.ts): chưa có scraped_article =
  // chưa có bài WP nào cho post này. wp_dismissed_at IS NULL: tôn trọng "Bỏ qua" ở /wp-needed.
  // Ngưỡng reaction/comment lọc ở JS (không .gte ở SQL) vì là OR — xem dưới.
  const { data, error } = await db
    .from('post')
    .select(
      'id, comment_count, reaction_count, page_commented, media_url, image_backup_at, scraped_article!left(post_id)',
    )
    .eq('is_published', true)
    .is('scraped_article', null)
    .is('wp_dismissed_at', null)
    .gte('fb_created_at', fromIso)
    .lte('fb_created_at', toIso);
  if (error) throw new Error(`Đọc bài đủ ngưỡng auto-publish lỗi: ${error.message}`);

  // OR, không phải AND — cùng logic với needsWpOrFilter() ở /wp-needed (lib/queries.ts): bài
  // nổi/reaction cao dù ít comment, hoặc bàn tán nhiều dù ít reaction, đều đáng viết bài WP.
  // "Comment thật" = tổng comment trừ đi comment của chính page (nếu có) — cùng lý do với
  // lib/attention.ts (comment_count TÍNH CẢ comment của page, không trừ được chính xác hơn vì
  // page_commented chỉ là boolean).
  //
  // Chặn thêm: bài CÓ ảnh (media_url) nhưng CHƯA được thử backup vào Supabase Storage
  // (image_backup_at NULL) thì CHƯA đủ điều kiện enqueue — Stage 2 (Gemini) chỉ chạy 1 lần rồi
  // chốt image_url vào wp_content_queue/wp_publish_queue mãi mãi (xem lib/wp-article-gen.ts:
  // KHÔNG fallback về media_url), nên enqueue sớm quá sẽ khiến bài WP kẹt không ảnh dù backup
  // xong sau đó. Bài không có ảnh gốc (media_url null) thì không cần đợi gì cả.
  const due = ((data ?? []) as Candidate[])
    .filter((p) => p.media_url === null || p.image_backup_at !== null)
    .filter((p) => {
      const real = (p.comment_count ?? 0) - (p.page_commented ? 1 : 0);
      return (p.reaction_count ?? 0) >= minReactions || real >= minComments;
    });
  if (!due.length) return { enqueued: 0 };

  // ignoreDuplicates = ON CONFLICT DO NOTHING: post đã có hàng (bất kể trạng thái) thì bỏ qua,
  // không ghi đè lại PENDING lên 1 hàng đang PROCESSING/DONE/FAILED.
  const { error: insErr } = await db
    .from('wp_content_queue')
    .upsert(
      due.map((p) => ({ post_id: p.id })),
      { onConflict: 'post_id', ignoreDuplicates: true },
    );
  if (insErr) throw new Error(`Ghi wp_content_queue lỗi: ${insErr.message}`);
  return { enqueued: due.length };
}

// ============================================================
// Stage 2 — sinh nội dung qua Gemini (wp_content_queue). Cron riêng, ĐẮT (1 lần gọi Gemini/bài).
// ============================================================

interface ContentQueueRow {
  id: string;
  post_id: string;
  attempts: number;
}

const CONTENT_SELECT = 'id, post_id, attempts';

async function claimContentPending(db: SupabaseClient, id: string): Promise<ContentQueueRow | null> {
  const { data, error } = await db
    .from('wp_content_queue')
    .update({ status: 'PROCESSING', claimed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'PENDING')
    .select(CONTENT_SELECT)
    .maybeSingle();
  if (error) throw error;
  return (data as ContentQueueRow) ?? null;
}

async function reclaimContentProcessing(
  db: SupabaseClient,
  id: string,
  staleCutoffIso: string,
): Promise<ContentQueueRow | null> {
  const { data, error } = await db
    .from('wp_content_queue')
    .update({ claimed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'PROCESSING')
    .lte('claimed_at', staleCutoffIso)
    .select(CONTENT_SELECT)
    .maybeSingle();
  if (error) throw error;
  return (data as ContentQueueRow) ?? null;
}

async function processContentRow(db: SupabaseClient, row: ContentQueueRow): Promise<'DONE' | 'FAILED'> {
  try {
    const article = await generateWpArticleFromFb(db, row.post_id);
    await db
      .from('wp_content_queue')
      .update({
        status: 'DONE',
        title: article.title,
        content_html: article.contentHtml,
        image_url: article.imageUrl,
        source_url: article.sourceUrl,
        error: null,
      })
      .eq('id', row.id)
      .eq('status', 'PROCESSING');

    // Bắc cầu sang hàng đợi 2 — COPY field, không join lại lúc đăng (cùng lý do
    // scheduled_comment denormalize fb_post_id/page_id, xem lib/comments.ts).
    const { error: pubErr } = await db.from('wp_publish_queue').upsert(
      {
        post_id: row.post_id,
        title: article.title,
        content_html: article.contentHtml,
        image_url: article.imageUrl,
        source_url: article.sourceUrl,
      },
      { onConflict: 'post_id', ignoreDuplicates: true },
    );
    if (pubErr) console.error(`  ↳ KHÔNG ghi được wp_publish_queue cho post ${row.post_id}: ${pubErr.message}`);
    return 'DONE';
  } catch (e) {
    const attempts = (row.attempts ?? 0) + 1;
    const msg = e instanceof WpArticleGenError ? e.message : (e as Error).message;
    // Còn lượt thử -> quay lại PENDING để cron sau tự thử lại; hết lượt -> đứng yên ở FAILED.
    const status = attempts < MAX_ATTEMPTS ? 'PENDING' : 'FAILED';
    await db
      .from('wp_content_queue')
      .update({ status, error: msg, attempts })
      .eq('id', row.id)
      .eq('status', 'PROCESSING');
    return 'FAILED';
  }
}

export async function processWpContentQueue(
  db: SupabaseClient = createSupabaseAdmin(),
  limit = 3,
): Promise<{ scanned: number; done: number; failed: number }> {
  const staleCutoff = new Date(Date.now() - STALE_MS).toISOString();
  const [{ data: pend }, { data: stale }] = await Promise.all([
    db.from('wp_content_queue').select(CONTENT_SELECT).eq('status', 'PENDING').limit(limit),
    db.from('wp_content_queue').select(CONTENT_SELECT).eq('status', 'PROCESSING').lte('claimed_at', staleCutoff).limit(limit),
  ]);

  let done = 0;
  let failed = 0;
  for (const row of (pend ?? []) as ContentQueueRow[]) {
    const claimed = await claimContentPending(db, row.id);
    if (!claimed) continue;
    if ((await processContentRow(db, claimed)) === 'DONE') done++;
    else failed++;
  }
  for (const row of (stale ?? []) as ContentQueueRow[]) {
    const claimed = await reclaimContentProcessing(db, row.id, staleCutoff);
    if (!claimed) continue;
    if ((await processContentRow(db, claimed)) === 'DONE') done++;
    else failed++;
  }
  return { scanned: (pend?.length ?? 0) + (stale?.length ?? 0), done, failed };
}

// ============================================================
// Stage 3 — đăng WordPress + comment FB (wp_publish_queue). Cron riêng, ĐẮT (WP XML-RPC + FB API).
// ============================================================

interface PublishQueueRow {
  id: string;
  post_id: string;
  title: string;
  content_html: string;
  image_url: string | null;
  source_url: string | null;
  attempts: number;
}

const PUBLISH_SELECT = 'id, post_id, title, content_html, image_url, source_url, attempts';

async function claimPublishPending(db: SupabaseClient, id: string): Promise<PublishQueueRow | null> {
  const { data, error } = await db
    .from('wp_publish_queue')
    .update({ status: 'PROCESSING', claimed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'PENDING')
    .select(PUBLISH_SELECT)
    .maybeSingle();
  if (error) throw error;
  return (data as PublishQueueRow) ?? null;
}

async function reclaimPublishProcessing(
  db: SupabaseClient,
  id: string,
  staleCutoffIso: string,
): Promise<PublishQueueRow | null> {
  const { data, error } = await db
    .from('wp_publish_queue')
    .update({ claimed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'PROCESSING')
    .lte('claimed_at', staleCutoffIso)
    .select(PUBLISH_SELECT)
    .maybeSingle();
  if (error) throw error;
  return (data as PublishQueueRow) ?? null;
}

// Đăng comment "Full story: {permalink}" NGAY — cùng dedupe-by-message + insert + drainOne() với
// POST /api/posts/[postDbId]/comments, để không bao giờ tạo 2 comment giống hệt cho cùng 1 bài.
async function postFullStoryComment(db: SupabaseClient, postId: string, permalink: string): Promise<boolean> {
  const message = `Full story: ${permalink}`;
  const { data: dup } = await db
    .from('scheduled_comment')
    .select('id')
    .eq('post_id', postId)
    .eq('message', message)
    .neq('status', 'FAILED')
    .limit(1)
    .maybeSingle();
  if (dup) return true; // đã lên lịch/đã gửi rồi — coi như xong

  const { data: post } = await db.from('post').select('fb_post_id, page_id').eq('id', postId).maybeSingle();
  if (!post) return false;
  const p = post as { fb_post_id: string; page_id: string };

  const { data: inserted, error } = await db
    .from('scheduled_comment')
    .insert({
      post_id: postId,
      fb_post_id: p.fb_post_id,
      page_id: p.page_id,
      message,
      run_after: new Date().toISOString(),
      status: 'PENDING',
    })
    .select('id')
    .single();
  if (error || !inserted) return false;

  return (await drainOne((inserted as { id: string }).id)) === 'SENT';
}

async function processPublishRow(db: SupabaseClient, row: PublishQueueRow): Promise<{ status: 'PUBLISHED' | 'FAILED'; commented: boolean }> {
  try {
    const result = await publishWpArticleForPost(db, row.post_id, {
      sourceUrl: row.source_url ?? '',
      title: row.title,
      contentHtml: row.content_html,
      imageMode: 'auto',
      autoImageUrl: row.image_url,
      wpStatus: 'publish',
    });
    if ('error' in result) throw new Error(result.error);

    // Comment lỗi KHÔNG được coi là cả hàng thất bại — bài WP đã đăng thật, phần comment còn
    // nút "Đăng vào comment" cho user bấm tay bù, không mất trắng công đã làm.
    const commented = result.permalink ? await postFullStoryComment(db, row.post_id, result.permalink) : false;

    await db
      .from('wp_publish_queue')
      .update({
        status: 'PUBLISHED',
        wp_post_id: result.wpPostId,
        permalink: result.permalink,
        error: commented ? null : 'Đăng WP xong nhưng comment "Full story" lỗi — bấm tay ở nút "Đăng vào comment"',
      })
      .eq('id', row.id)
      .eq('status', 'PROCESSING');
    return { status: 'PUBLISHED', commented };
  } catch (e) {
    const attempts = (row.attempts ?? 0) + 1;
    // Còn lượt thử -> quay lại PENDING để cron sau tự thử lại; hết lượt -> đứng yên ở FAILED.
    const status = attempts < MAX_ATTEMPTS ? 'PENDING' : 'FAILED';
    await db
      .from('wp_publish_queue')
      .update({ status, error: (e as Error).message, attempts })
      .eq('id', row.id)
      .eq('status', 'PROCESSING');
    return { status: 'FAILED', commented: false };
  }
}

export async function processWpPublishQueue(
  db: SupabaseClient = createSupabaseAdmin(),
  limit = 3,
): Promise<{ scanned: number; published: number; commented: number; failed: number }> {
  const staleCutoff = new Date(Date.now() - STALE_MS).toISOString();
  const [{ data: pend }, { data: stale }] = await Promise.all([
    db.from('wp_publish_queue').select(PUBLISH_SELECT).eq('status', 'PENDING').limit(limit),
    db.from('wp_publish_queue').select(PUBLISH_SELECT).eq('status', 'PROCESSING').lte('claimed_at', staleCutoff).limit(limit),
  ]);

  let published = 0;
  let commented = 0;
  let failed = 0;
  for (const row of (pend ?? []) as PublishQueueRow[]) {
    const claimed = await claimPublishPending(db, row.id);
    if (!claimed) continue;
    const r = await processPublishRow(db, claimed);
    if (r.status === 'PUBLISHED') published++;
    else failed++;
    if (r.commented) commented++;
  }
  for (const row of (stale ?? []) as PublishQueueRow[]) {
    const claimed = await reclaimPublishProcessing(db, row.id, staleCutoff);
    if (!claimed) continue;
    const r = await processPublishRow(db, claimed);
    if (r.status === 'PUBLISHED') published++;
    else failed++;
    if (r.commented) commented++;
  }
  return { scanned: (pend?.length ?? 0) + (stale?.length ?? 0), published, commented, failed };
}
