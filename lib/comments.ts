import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdmin } from './supabase/admin';
import { decryptToken } from './crypto';
import { createPostComment, FacebookError } from './facebook/client';
import type { ScheduledCommentRow } from './types';

function fmtError(e: unknown): string {
  if (e instanceof FacebookError) {
    const code = e.code !== undefined ? `${e.code}${e.subcode ? '/' + e.subcode : ''}` : '';
    return `[FB ${code}] ${e.message}`;
  }
  return (e as Error).message ?? 'Lỗi không xác định';
}

// Gọi FB đăng comment cho 1 row đã được claim (status=PROCESSING) rồi cập nhật SENT/FAILED.
async function sendComment(db: SupabaseClient, row: ScheduledCommentRow): Promise<'SENT' | 'FAILED'> {
  try {
    const { data: page, error } = await db
      .from('facebook_page')
      .select('access_token')
      .eq('page_id', row.page_id)
      .maybeSingle();
    if (error) throw error;
    if (!page) throw new Error(`Không tìm thấy page ${row.page_id} trong facebook_page`);

    const token = decryptToken((page as { access_token: string }).access_token);
    const result = await createPostComment(row.fb_post_id, token, {
      message: row.message,
      attachmentUrl: row.attachment_url ?? undefined,
    });

    await db
      .from('scheduled_comment')
      .update({ status: 'SENT', fb_comment_id: result.id, sent_at: new Date().toISOString(), error: null })
      .eq('id', row.id);
    return 'SENT';
  } catch (e) {
    await db
      .from('scheduled_comment')
      .update({ status: 'FAILED', error: fmtError(e), attempts: (row.attempts ?? 0) + 1 })
      .eq('id', row.id);
    return 'FAILED';
  }
}

// Claim atomic 1 row PENDING -> PROCESSING. Trả về row nếu thắng, null nếu đã bị bên khác claim.
async function claimPending(db: SupabaseClient, id: string): Promise<ScheduledCommentRow | null> {
  const { data, error } = await db
    .from('scheduled_comment')
    .update({ status: 'PROCESSING', claimed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'PENDING')
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
export async function drainOne(commentId: string): Promise<'SENT' | 'FAILED' | 'SKIPPED' | 'NOT_DUE'> {
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
): Promise<{ sent: number; failed: number; skipped: number; scanned: number }> {
  const db = createSupabaseAdmin();
  const now = Date.now();
  const pendingCutoff = new Date(now - (opts.pendingBufferMs ?? 0)).toISOString();
  const staleCutoff = new Date(now - (opts.staleMs ?? 120_000)).toISOString();
  const limit = opts.limit ?? 50;

  const [{ data: pend }, { data: stale }] = await Promise.all([
    db.from('scheduled_comment').select('*').eq('status', 'PENDING').lte('run_after', pendingCutoff).limit(limit),
    db.from('scheduled_comment').select('*').eq('status', 'PROCESSING').lte('claimed_at', staleCutoff).limit(limit),
  ]);

  const res = { sent: 0, failed: 0, skipped: 0, scanned: (pend?.length ?? 0) + (stale?.length ?? 0) };

  for (const row of (pend ?? []) as ScheduledCommentRow[]) {
    const claimed = await claimPending(db, row.id);
    if (!claimed) {
      res.skipped++;
      continue;
    }
    if ((await sendComment(db, claimed)) === 'SENT') res.sent++;
    else res.failed++;
  }
  for (const row of (stale ?? []) as ScheduledCommentRow[]) {
    const claimed = await reclaimProcessing(db, row.id, staleCutoff);
    if (!claimed) {
      res.skipped++;
      continue;
    }
    if ((await sendComment(db, claimed)) === 'SENT') res.sent++;
    else res.failed++;
  }
  return res;
}
