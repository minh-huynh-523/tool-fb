// Port của lib/comments.ts cho Deno — 2 phần:
//   1) postFullStoryComment — bản đơn giản hoá riêng cho auto-publish (đăng NGAY 1 comment vừa
//      tạo, xem lib/auto-publish.ts bản Next.js).
//   2) claimPending/reclaimProcessing/sendComment/processDueComments/drainOne — bản port ĐẦY ĐỦ
//      của worker rút hàng đợi scheduled_comment chung (mọi comment, không chỉ "Full story"),
//      dùng bởi Edge Function process-comments (an toàn lưới cho sync-pages + rút ngay sau khi
//      Next.js insert 1 comment mới, xem app/api/posts/[postDbId]/comments/route.ts).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createPostComment, FacebookError } from "./facebook.ts";
import { decryptToken } from "./crypto.ts";

export async function postFullStoryComment(db: SupabaseClient, postId: string, permalink: string): Promise<boolean> {
  const message = `Full story: ${permalink}`;

  // Chặn trùng — cùng logic dedupe với POST /api/posts/[postDbId]/comments (Next.js).
  const { data: dup } = await db
    .from("scheduled_comment")
    .select("id")
    .eq("post_id", postId)
    .eq("message", message)
    .neq("status", "FAILED")
    .limit(1)
    .maybeSingle();
  if (dup) return true; // đã lên lịch/đã gửi rồi — coi như xong

  const { data: post } = await db.from("post").select("fb_post_id, page_id").eq("id", postId).maybeSingle();
  if (!post) return false;

  const { data: inserted, error: insErr } = await db
    .from("scheduled_comment")
    .insert({
      post_id: postId,
      fb_post_id: post.fb_post_id,
      page_id: post.page_id,
      message,
      run_after: new Date().toISOString(),
      status: "PROCESSING", // claim luôn — không cần bước PENDING riêng vì gửi ngay trong hàm này
      claimed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insErr) {
    // 23505 = vi phạm scheduled_comment_no_dup_idx — race với 1 lượt khác (Vercel manual run hoặc
    // nút "Đăng vào comment") vừa chèn Y HỆT message này trước 1 nhịp. ĐÃ CÓ comment rồi, không
    // phải lỗi thật — coi như xong. Xem lib/auto-publish.ts bản Next.js để biết lý do đầy đủ.
    if (insErr.code === "23505") return true;
    return false;
  }
  if (!inserted) return false;

  try {
    const { data: page, error: pageErr } = await db
      .from("facebook_page")
      .select("access_token")
      .eq("page_id", post.page_id)
      .maybeSingle();
    if (pageErr) throw new Error(pageErr.message);
    if (!page) throw new Error(`Không tìm thấy page ${post.page_id}`);

    const token = decryptToken(page.access_token);
    const result = await createPostComment(post.fb_post_id, token, { message });

    await db
      .from("scheduled_comment")
      .update({ status: "SENT", fb_comment_id: result.id, sent_at: new Date().toISOString(), error: null })
      .eq("id", inserted.id)
      .eq("status", "PROCESSING");
    return true;
  } catch (e) {
    const msg = e instanceof FacebookError ? e.message : e instanceof Error ? e.message : String(e);
    await db.from("scheduled_comment").update({ status: "FAILED", error: msg, attempts: 1 }).eq("id", inserted.id).eq("status", "PROCESSING");
    return false;
  }
}

// ============================================================
// Worker rút hàng đợi CHUNG (mọi scheduled_comment, không chỉ "Full story") — port của
// lib/comments.ts. target luôn RESOLVE lại từ bảng post tại thời điểm gửi (không tin
// fb_post_id denormalize trên row — reel lên lịch đổi id khi publish, xem _shared/sync.ts).
// ============================================================

interface ScheduledCommentRow {
  id: string;
  post_id: string;
  fb_post_id: string;
  page_id: string;
  message: string | null;
  attachment_url: string | null;
  attempts: number;
  run_after: string;
  status: string;
}

// Cột tường minh thay cho select('*') — bỏ created_at/sent_at/error/fb_comment_id/claimed_at
// (không dùng khi gửi). Cùng lý do với POST_COLUMNS ở lib/queries.ts, nhưng gắt hơn: hàng đợi này
// được kéo về MỖI LƯỢT CRON, nên cột thừa nhân lên theo số lượt chứ không phải theo số row.
const ROW_COLS = "id, post_id, fb_post_id, page_id, message, attachment_url, attempts, run_after, status";

// "Bài đã reconcile" = fb_post_id dạng <page>_<post>. Reel lên lịch mang video-id TRẦN cho tới khi
// lên sóng (xem _shared/sync.ts), và comment cho nó thì KHÔNG THỂ gửi.
// ⚠ '*' là ký tự đại diện của PostgREST, còn '\_' mới là gạch dưới đúng nghĩa — quên escape thì '_'
// thành wildcard 1 ký tự và filter khớp mọi thứ, tức là mất tác dụng mà không báo lỗi.
const RECONCILED = "*\\_*";

// PENDING quá ngần này giờ mà bài vẫn chưa reconcile thì bỏ cuộc. BẮT BUỘC phải có: từ khi
// processDueComments lọc bằng post!inner, những row này không còn được nhặt lên nữa — không có mốc
// hết hạn thì chúng nằm PENDING im lặng vĩnh viễn và không ai biết comment đã hụt.
const PENDING_EXPIRE_HOURS = 24;

function fmtError(e: unknown): string {
  if (e instanceof FacebookError) {
    const code = e.code !== undefined ? `${e.code}${e.subcode ? "/" + e.subcode : ""}` : "";
    const trace = e.fbtraceId ? ` (trace ${e.fbtraceId})` : "";
    return `[FB ${code}] ${e.message}${trace}`;
  }
  return (e as Error).message ?? "Lỗi không xác định";
}

async function sendComment(db: SupabaseClient, row: ScheduledCommentRow): Promise<"SENT" | "FAILED" | "SKIPPED"> {
  try {
    const { data: postRow } = await db.from("post").select("fb_post_id").eq("id", row.post_id).maybeSingle();
    const target = (postRow as { fb_post_id: string } | null)?.fb_post_id ?? row.fb_post_id;

    // Vẫn là video-id placeholder (không có "_") = bài CHƯA lên sóng/chưa reconcile — nhả về
    // PENDING, lượt sync-pages/process-comments sau tự thử lại sau khi reconcile.
    //
    // processDueComments giờ đã lọc hẳn nhóm này ra từ query (vế post!inner), nên nhánh này chỉ
    // còn chạm tới ở 2 đường hiếm: reclaim 1 row PROCESSING treo, và drainOne gọi thẳng. Vẫn TĂNG
    // attempts — trước đây nhánh này nhả về PENDING mà không đếm gì, nên không có cách nào phân
    // biệt "vừa thử lần đầu" với "đã quay vòng 3000 lượt".
    if (!target.includes("_")) {
      await db
        .from("scheduled_comment")
        .update({ status: "PENDING", claimed_at: null, attempts: (row.attempts ?? 0) + 1 })
        .eq("id", row.id)
        .eq("status", "PROCESSING");
      return "SKIPPED";
    }

    const { data: page, error } = await db.from("facebook_page").select("access_token").eq("page_id", row.page_id).maybeSingle();
    if (error) throw error;
    if (!page) throw new Error(`Không tìm thấy page ${row.page_id} trong facebook_page`);

    const token = decryptToken((page as { access_token: string }).access_token);
    const result = await createPostComment(target, token, {
      message: row.message ?? undefined,
      attachmentUrl: row.attachment_url ?? undefined,
    });

    await db
      .from("scheduled_comment")
      .update({ status: "SENT", fb_comment_id: result.id, sent_at: new Date().toISOString(), error: null })
      .eq("id", row.id)
      .eq("status", "PROCESSING");
    return "SENT";
  } catch (e) {
    const attempts = (row.attempts ?? 0) + 1;
    await db
      .from("scheduled_comment")
      .update({ status: "FAILED", error: fmtError(e), attempts })
      .eq("id", row.id)
      .eq("status", "PROCESSING");
    return "FAILED";
  }
}

/**
 * Giành quyền xử lý 1 row. Trả CÓ/KHÔNG chứ không trả row: người gọi đã cầm sẵn dữ liệu row từ
 * query danh sách, mà `.select()` trống thì PostgREST trả về NGUYÊN row (kể cả `message` dài vài
 * KB) chỉ để nói cho ta biết mình có thắng race hay không.
 */
async function claimPending(db: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await db
    .from("scheduled_comment")
    .update({ status: "PROCESSING", claimed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "PENDING")
    .lte("run_after", new Date().toISOString())
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function reclaimProcessing(db: SupabaseClient, id: string, staleCutoffIso: string): Promise<boolean> {
  const { data, error } = await db
    .from("scheduled_comment")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "PROCESSING")
    .lte("claimed_at", staleCutoffIso)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// Rút MỘT job cụ thể (dùng ngay sau khi Next.js insert 1 comment mới — thay cho after(() =>
// drainOne(id)) chạy trong tiến trình Vercel trước đây).
export async function drainOne(db: SupabaseClient, commentId: string): Promise<"SENT" | "FAILED" | "SKIPPED" | "NOT_DUE"> {
  // Lấy đủ cột ngay từ đầu (thay vì chỉ run_after/status rồi để claimPending fetch lại lần nữa):
  // vẫn đúng 1 lượt GET như trước, nhưng claim sau đó không phải trả row về nữa.
  const { data: row } = await db.from("scheduled_comment").select(ROW_COLS).eq("id", commentId).maybeSingle();
  if (!row) return "SKIPPED";
  const r = row as unknown as ScheduledCommentRow;
  if (r.status !== "PENDING") return "SKIPPED";
  if (new Date(r.run_after).getTime() > Date.now()) return "NOT_DUE";
  if (!(await claimPending(db, r.id))) return "SKIPPED";
  return sendComment(db, r);
}

// WORKER quét toàn hàng đợi: PENDING đã tới hạn + PROCESSING treo — dùng bởi Edge Function
// process-comments (an toàn lưới, gọi định kỳ độc lập với sync-pages).
export async function processDueComments(
  db: SupabaseClient,
  opts: { pendingBufferMs?: number; staleMs?: number; limit?: number } = {},
): Promise<{ sent: number; failed: number; retried: number; skipped: number; scanned: number; expired: number }> {
  const now = Date.now();
  const pendingCutoff = new Date(now - (opts.pendingBufferMs ?? 0)).toISOString();
  const staleCutoff = new Date(now - (opts.staleMs ?? 120_000)).toISOString();
  const limit = opts.limit ?? 50;

  const [{ data: pend }, { data: stale }] = await Promise.all([
    // post!inner + like: CHỈ nhặt row mà bài ĐÃ reconcile. Bài chưa lên sóng thì đừng claim làm gì
    // — sendComment chỉ nhả nó về PENDING rồi lượt sau lại nhặt đúng nó lên.
    //
    // ⚠ Vòng lặp đó là nguyên nhân egress Supabase tăng vọt: đo trên edge_logs 24h thấy 31.390
    // request, trong đó ~20.000 (2/3) sinh ra bởi ĐÚNG 6 row chết — mỗi row 3 round-trip (PATCH
    // claim trả nguyên row + GET post + PATCH nhả), × 42 lượt/giờ, vĩnh viễn vì nhánh SKIPPED
    // không tăng attempts nên chẳng bao giờ chạm trần nào.
    db
      .from("scheduled_comment")
      .select(`${ROW_COLS}, post!inner(fb_post_id)`)
      .eq("status", "PENDING")
      .lte("run_after", pendingCutoff)
      .like("post.fb_post_id", RECONCILED)
      .limit(limit),
    db.from("scheduled_comment").select(ROW_COLS).eq("status", "PROCESSING").lte("claimed_at", staleCutoff).limit(limit),
  ]);

  // Gỡ khoá embed trước khi dùng: `post` chỉ để lọc, không phải dữ liệu của ScheduledCommentRow
  // (cùng cách listPostsWithCommentStatus xử lý `scraped_article` ở lib/queries.ts).
  const pendRows = ((pend ?? []) as unknown as Array<ScheduledCommentRow & { post?: unknown }>).map((r) => {
    const row = { ...r };
    delete row.post;
    return row as ScheduledCommentRow;
  });
  const staleRows = (stale ?? []) as unknown as ScheduledCommentRow[];

  const res = { sent: 0, failed: 0, retried: 0, skipped: 0, scanned: pendRows.length + staleRows.length, expired: 0 };
  const tally = (r: "SENT" | "FAILED" | "SKIPPED") => {
    if (r === "SENT") res.sent++;
    else if (r === "FAILED") res.failed++;
    else res.skipped++;
  };

  for (const row of pendRows) {
    if (!(await claimPending(db, row.id))) {
      res.skipped++;
      continue;
    }
    tally(await sendComment(db, row));
  }
  for (const row of staleRows) {
    if (!(await reclaimProcessing(db, row.id, staleCutoff))) {
      res.skipped++;
      continue;
    }
    tally(await sendComment(db, row));
  }

  res.expired = await expireUnreachable(db, now, limit);
  return res;
}

/**
 * Đánh FAILED những comment mà bài GẮN VỚI NÓ không bao giờ reconcile (reel bị xoá / không lên
 * sóng). Vế post!inner ở processDueComments cố tình không nhặt chúng lên nữa, nên nếu không có
 * lượt quét này thì chúng nằm PENDING vĩnh viễn mà không ai biết — im lặng còn tệ hơn tốn egress.
 *
 * Rẻ: 1 GET chỉ lấy id (thường rỗng) + tối đa 1 PATCH gộp cho cả lô. Điều kiện `not.like` khớp
 * đúng phần bù của bộ lọc ở trên, nên KHÔNG bao giờ chạm nhầm row còn gửi được — kể cả row vừa bị
 * trần `limit` cắt khỏi lượt này.
 */
async function expireUnreachable(db: SupabaseClient, now: number, limit: number): Promise<number> {
  const cutoff = new Date(now - PENDING_EXPIRE_HOURS * 3600_000).toISOString();
  const { data } = await db
    .from("scheduled_comment")
    .select("id, post!inner(fb_post_id)")
    .eq("status", "PENDING")
    .lte("run_after", cutoff)
    .not("post.fb_post_id", "like", RECONCILED)
    .limit(limit);
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (!ids.length) return 0;

  const { error } = await db
    .from("scheduled_comment")
    .update({
      status: "FAILED",
      claimed_at: null,
      error: `Quá ${PENDING_EXPIRE_HOURS}h kể từ giờ hẹn mà bài vẫn chưa lên sóng (fb_post_id còn là video-id lên lịch, chưa reconcile) — bỏ cuộc.`,
    })
    .in("id", ids)
    .eq("status", "PENDING");
  if (error) {
    console.error(`[comments] đánh FAILED ${ids.length} comment quá hạn lỗi: ${error.message}`);
    return 0;
  }
  return ids.length;
}
