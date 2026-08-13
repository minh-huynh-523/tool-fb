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
}

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
    if (!target.includes("_")) {
      await db.from("scheduled_comment").update({ status: "PENDING", claimed_at: null }).eq("id", row.id).eq("status", "PROCESSING");
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

async function claimPending(db: SupabaseClient, id: string): Promise<ScheduledCommentRow | null> {
  const { data, error } = await db
    .from("scheduled_comment")
    .update({ status: "PROCESSING", claimed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "PENDING")
    .lte("run_after", new Date().toISOString())
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as ScheduledCommentRow) ?? null;
}

async function reclaimProcessing(db: SupabaseClient, id: string, staleCutoffIso: string): Promise<ScheduledCommentRow | null> {
  const { data, error } = await db
    .from("scheduled_comment")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "PROCESSING")
    .lte("claimed_at", staleCutoffIso)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as ScheduledCommentRow) ?? null;
}

// Rút MỘT job cụ thể (dùng ngay sau khi Next.js insert 1 comment mới — thay cho after(() =>
// drainOne(id)) chạy trong tiến trình Vercel trước đây).
export async function drainOne(db: SupabaseClient, commentId: string): Promise<"SENT" | "FAILED" | "SKIPPED" | "NOT_DUE"> {
  const { data: row } = await db.from("scheduled_comment").select("run_after,status").eq("id", commentId).maybeSingle();
  if (!row) return "SKIPPED";
  if ((row as { status: string }).status !== "PENDING") return "SKIPPED";
  if (new Date((row as { run_after: string }).run_after).getTime() > Date.now()) return "NOT_DUE";
  const claimed = await claimPending(db, commentId);
  if (!claimed) return "SKIPPED";
  return sendComment(db, claimed);
}

// WORKER quét toàn hàng đợi: PENDING đã tới hạn + PROCESSING treo — dùng bởi Edge Function
// process-comments (an toàn lưới, gọi định kỳ độc lập với sync-pages).
export async function processDueComments(
  db: SupabaseClient,
  opts: { pendingBufferMs?: number; staleMs?: number; limit?: number } = {},
): Promise<{ sent: number; failed: number; retried: number; skipped: number; scanned: number }> {
  const now = Date.now();
  const pendingCutoff = new Date(now - (opts.pendingBufferMs ?? 0)).toISOString();
  const staleCutoff = new Date(now - (opts.staleMs ?? 120_000)).toISOString();
  const limit = opts.limit ?? 50;

  const [{ data: pend }, { data: stale }] = await Promise.all([
    db.from("scheduled_comment").select("*").eq("status", "PENDING").lte("run_after", pendingCutoff).limit(limit),
    db.from("scheduled_comment").select("*").eq("status", "PROCESSING").lte("claimed_at", staleCutoff).limit(limit),
  ]);

  const res = { sent: 0, failed: 0, retried: 0, skipped: 0, scanned: (pend?.length ?? 0) + (stale?.length ?? 0) };
  const tally = (r: "SENT" | "FAILED" | "SKIPPED") => {
    if (r === "SENT") res.sent++;
    else if (r === "FAILED") res.failed++;
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
