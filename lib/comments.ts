import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdmin } from './supabase/admin';
import { decryptToken } from './crypto';
import { createPostComment, FacebookError } from './facebook/client';
import type { ScheduledCommentRow } from './types';

// Giữ fbtrace_id: đây là thứ DUY NHẤT Meta hỏi tới khi mở ticket cho mấy lỗi "unknown error",
// mà lỗi đó chiếm phần lớn ca fail ở đây — vứt đi là mất luôn đường tra.
function fmtError(e: unknown): string {
  if (e instanceof FacebookError) {
    const code = e.code !== undefined ? `${e.code}${e.subcode ? '/' + e.subcode : ''}` : '';
    const trace = e.fbtraceId ? ` (trace ${e.fbtraceId})` : '';
    return `[FB ${code}] ${e.message}${trace}`;
  }
  return (e as Error).message ?? 'Lỗi không xác định';
}

/**
 * Lỗi FB đáng thử lại.
 *
 * Danh sách CỐ Ý là whitelist ngắn: chỉ retry cái biết chắc tạm thời. Đoán sai theo chiều ngược
 * lại đắt hơn nhiều — phân loại nhầm 190 (token chết) thành retryable thì mỗi lượt cron sẽ đập
 * token hỏng vào FB thêm 3 lần, trên mọi page, mỗi phút.
 *
 *   1   unknown error   — catch-all; chiếm 10/10 ca fail thực tế của dự án này
 *   2   service tạm lỗi
 *   4   rate limit mức app
 *   17  rate limit mức user
 *   341 app đạt trần call
 *
 * KHÔNG retry: 100 (tham số sai — gồm cả vượt độ dài), 190 (token), 200/10 (thiếu quyền),
 * 1404006 (post tắt comment). Lỗi không phải FacebookError (DB, decrypt token, page thiếu
 * trong bảng) cũng không retry: đó là sai cấu hình, thử lại chỉ tốn call.
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341]);
const MAX_ATTEMPTS = 3;
// 5ph → 15ph. Lượt thứ 3 hết backoff nên FAILED luôn.
const BACKOFF_MS = [5 * 60_000, 15 * 60_000];

function isRetryable(e: unknown): boolean {
  if (!(e instanceof FacebookError)) return false;
  // Hết giờ chờ = KHÔNG biết FB đã tạo comment hay chưa. Thử lại có thể ra 2 comment trùng trên
  // bài — để FAILED cho người dùng nhìn bài rồi tự quyết, đắt hơn nhiều nếu đoán sai chiều kia.
  if (e.type === 'timeout') return false;
  if (e.code === undefined) return true; // lỗi mạng: FacebookError ném ra không kèm code
  if (e.status !== undefined && e.status >= 500) return true;
  return RETRYABLE_CODES.has(e.code);
}

// Gọi FB đăng comment cho 1 row đã được claim (status=PROCESSING) rồi cập nhật SENT/FAILED.
// Target được RESOLVE TẠI THỜI ĐIỂM GỬI từ bảng post (post_id uuid ổn định) — vì reel lên lịch
// Business Suite đổi fb_post_id khi publish; giá trị denormalize trên row có thể đã chết.
async function sendComment(
  db: SupabaseClient,
  row: ScheduledCommentRow,
): Promise<'SENT' | 'FAILED' | 'SKIPPED' | 'RETRY'> {
  try {
    const { data: postRow } = await db
      .from('post')
      .select('fb_post_id')
      .eq('id', row.post_id)
      .maybeSingle();
    const target = (postRow as { fb_post_id: string } | null)?.fb_post_id ?? row.fb_post_id;

    // Vẫn là video-id placeholder (không có "_") = bài CHƯA lên sóng/chưa reconcile.
    // Đừng bắn (chắc chắn fail) — nhả về PENDING, cron lần sau thử lại sau khi sync reconcile.
    if (!target.includes('_')) {
      await db
        .from('scheduled_comment')
        .update({ status: 'PENDING', claimed_at: null })
        .eq('id', row.id)
        .eq('status', 'PROCESSING');
      return 'SKIPPED';
    }

    const { data: page, error } = await db
      .from('facebook_page')
      .select('access_token')
      .eq('page_id', row.page_id)
      .maybeSingle();
    if (error) throw error;
    if (!page) throw new Error(`Không tìm thấy page ${row.page_id} trong facebook_page`);

    const token = decryptToken((page as { access_token: string }).access_token);
    const result = await createPostComment(target, token, {
      message: row.message,
      attachmentUrl: row.attachment_url ?? undefined,
    });

    // Guard status=PROCESSING: worker chậm (bị stale-reclaim đè) không được ghi đè kết quả mới hơn.
    await db
      .from('scheduled_comment')
      .update({ status: 'SENT', fb_comment_id: result.id, sent_at: new Date().toISOString(), error: null })
      .eq('id', row.id)
      .eq('status', 'PROCESSING');
    return 'SENT';
  } catch (e) {
    // attempts đếm SỐ LẦN ĐÃ GỬI, tăng đúng 1 cho mỗi lần chạy sendComment. row.attempts luôn là
    // giá trị vừa đọc từ DB (claimPending/reclaimProcessing đều .select() sau update), nên đường
    // reclaim một row PROCESSING treo cũng không cộng trùng.
    const attempts = (row.attempts ?? 0) + 1;
    const backoff = BACKOFF_MS[attempts - 1];
    const retry = isRetryable(e) && attempts < MAX_ATTEMPTS && backoff !== undefined;

    // Guard status=PROCESSING giữ nguyên như đường SENT: worker chậm bị stale-reclaim đè
    // không được ghi đè kết quả mới hơn.
    await db
      .from('scheduled_comment')
      .update(
        retry
          ? {
              // Về lại hàng đợi, hẹn giờ sau. processDueComments vốn quét PENDING theo run_after
              // nên tự nhặt lại — không cần đường code riêng cho retry.
              status: 'PENDING',
              claimed_at: null,
              run_after: new Date(Date.now() + backoff).toISOString(),
              error: fmtError(e), // vẫn ghi để thấy lần thử gần nhất hỏng vì gì
              attempts,
            }
          : { status: 'FAILED', error: fmtError(e), attempts },
      )
      .eq('id', row.id)
      .eq('status', 'PROCESSING');
    return retry ? 'RETRY' : 'FAILED';
  }
}

// Claim atomic 1 row PENDING -> PROCESSING. Trả về row nếu thắng, null nếu đã bị bên khác claim.
// Re-check run_after NGAY TRONG claim: PATCH đổi lịch giữa lúc select và claim thì không bắn nhầm lịch cũ.
async function claimPending(db: SupabaseClient, id: string): Promise<ScheduledCommentRow | null> {
  const { data, error } = await db
    .from('scheduled_comment')
    .update({ status: 'PROCESSING', claimed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'PENDING')
    .lte('run_after', new Date().toISOString())
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as ScheduledCommentRow) ?? null;
}

// Reclaim 1 row PROCESSING bị treo (claimed_at <= cutoff) -> gia hạn claimed_at.
async function reclaimProcessing(
  db: SupabaseClient,
  id: string,
  staleCutoffIso: string,
): Promise<ScheduledCommentRow | null> {
  const { data, error } = await db
    .from('scheduled_comment')
    .update({ claimed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'PROCESSING')
    .lte('claimed_at', staleCutoffIso)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as ScheduledCommentRow) ?? null;
}

// Rút MỘT job cụ thể khỏi hàng đợi (dùng cho drain ngay sau enqueue): chỉ gửi nếu đã tới hạn.
export async function drainOne(
  commentId: string,
): Promise<'SENT' | 'FAILED' | 'SKIPPED' | 'NOT_DUE' | 'RETRY'> {
  const db = createSupabaseAdmin();
  const { data: row } = await db
    .from('scheduled_comment')
    .select('run_after,status')
    .eq('id', commentId)
    .maybeSingle();
  if (!row) return 'SKIPPED';
  if ((row as { status: string }).status !== 'PENDING') return 'SKIPPED';
  if (new Date((row as { run_after: string }).run_after).getTime() > Date.now()) return 'NOT_DUE';
  const claimed = await claimPending(db, commentId);
  if (!claimed) return 'SKIPPED';
  return sendComment(db, claimed);
}

// WORKER rút hàng đợi (cron / after): quét PENDING đã tới hạn (run_after<=now) + PROCESSING treo.
export async function processDueComments(
  opts: { pendingBufferMs?: number; staleMs?: number; limit?: number } = {},
): Promise<{ sent: number; failed: number; retried: number; skipped: number; scanned: number }> {
  const db = createSupabaseAdmin();
  const now = Date.now();
  const pendingCutoff = new Date(now - (opts.pendingBufferMs ?? 0)).toISOString();
  const staleCutoff = new Date(now - (opts.staleMs ?? 120_000)).toISOString();
  const limit = opts.limit ?? 50;

  const [{ data: pend }, { data: stale }] = await Promise.all([
    db.from('scheduled_comment').select('*').eq('status', 'PENDING').lte('run_after', pendingCutoff).limit(limit),
    db.from('scheduled_comment').select('*').eq('status', 'PROCESSING').lte('claimed_at', staleCutoff).limit(limit),
  ]);

  const res = { sent: 0, failed: 0, retried: 0, skipped: 0, scanned: (pend?.length ?? 0) + (stale?.length ?? 0) };
  const tally = (r: 'SENT' | 'FAILED' | 'SKIPPED' | 'RETRY') => {
    if (r === 'SENT') res.sent++;
    else if (r === 'FAILED') res.failed++;
    else if (r === 'RETRY') res.retried++;
    else res.skipped++;
  };

  for (const row of (pend ?? []) as ScheduledCommentRow[]) {
    const claimed = await claimPending(db, row.id);
    if (!claimed) {
      res.skipped++;
      continue;
    }
    tally(await sendComment(db, claimed));
  }
  for (const row of (stale ?? []) as ScheduledCommentRow[]) {
    const claimed = await reclaimProcessing(db, row.id, staleCutoff);
    if (!claimed) {
      res.skipped++;
      continue;
    }
    tally(await sendComment(db, claimed));
  }
  return res;
}
