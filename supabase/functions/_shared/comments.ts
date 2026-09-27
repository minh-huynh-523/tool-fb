// Port của lib/comments.ts cho Deno — 2 phần:
//   1) attachFullStoryLink — riêng cho auto-publish: nối link WP vào first comment sẵn có của page
//      (sửa trên FB nếu đã gửi); postFullStoryComment là đường lùi đăng NGAY 1 comment riêng.
//   2) claimPending/reclaimProcessing/sendComment/processDueComments/drainOne — bản port ĐẦY ĐỦ
//      của worker rút hàng đợi scheduled_comment chung (mọi comment, không chỉ "Full story"),
//      dùng bởi Edge Function process-comments (an toàn lưới cho sync-pages + rút ngay sau khi
//      Next.js insert 1 comment mới, xem app/api/posts/[postDbId]/comments/route.ts).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createPostComment, FacebookError, updateComment } from "./facebook.ts";
import { decryptToken } from "./crypto.ts";

// Trần của Facebook — mirror lib/constants.ts (FB_COMMENT_MAX_CHARS / FB_COMMENT_MAX_LINES), xem
// giải thích + số liệu ở đó. Deno không import được lib/ nên chép số.
const FB_COMMENT_MAX_CHARS = 8000;
const FB_COMMENT_MAX_LINES = 100;

/**
 * Stage 3 auto-publish: gắn link WP vào COMMENT SẴN CÓ của page trên bài (comment sớm nhất chưa
 * FAILED — tức first comment) thay vì tạo comment "Full story" riêng.
 *   - SENT  → sửa comment đó trên FB (POST /{fb_comment_id}) rồi ghi message mới vào DB.
 *   - PENDING → chỉ sửa message trong DB, worker gửi ra FB nguyên bản đã có link. Kể cả reel chưa
 *     reconcile: comment vẫn nằm chờ như cũ, chỉ là giờ đã mang sẵn link.
 * Rơi về tạo comment mới (postFullStoryComment) khi bài chưa có comment nào, hoặc nối link vào sẽ
 * vượt trần ký tự/dòng của FB — thà thêm 1 comment còn hơn gộp đoạn/cắt nội dung của người viết.
 * PROCESSING (worker đang cầm, đã đọc message) thì trả false — sửa lúc này sẽ bị worker đè mất.
 */
export async function attachFullStoryLink(db: SupabaseClient, postId: string, permalink: string): Promise<boolean> {
  const { data: rows, error } = await db
    .from("scheduled_comment")
    .select("id, page_id, message, status, fb_comment_id")
    .eq("post_id", postId)
    .neq("status", "FAILED")
    .order("run_after", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return false;
  const list = (rows ?? []) as Array<{
    id: string;
    page_id: string;
    message: string | null;
    status: string;
    fb_comment_id: string | null;
  }>;

  // Đã có link ở bất kỳ comment nào (lượt trước đã gắn, hoặc user bấm tay "Đăng vào comment").
  if (list.some((r) => r.message?.includes(permalink))) return true;

  const first = list[0];
  if (!first) return postFullStoryComment(db, postId, permalink);

  const suffix = `Full story: ${permalink}`;
  const base = (first.message ?? "").trimEnd();
  const message = base ? `${base}\n\n${suffix}` : suffix;
  if (message.length > FB_COMMENT_MAX_CHARS || message.split("\n").length > FB_COMMENT_MAX_LINES) {
    return postFullStoryComment(db, postId, permalink);
  }

  if (first.status === "PENDING") {
    const { data: updated, error: upErr } = await db
      .from("scheduled_comment")
      .update({ message })
      .eq("id", first.id)
      .eq("status", "PENDING") // optimistic: worker vừa claim thì thôi, không đè
      .select("id")
      .maybeSingle();
    return !upErr && Boolean(updated);
  }

  if (first.status !== "SENT" || !first.fb_comment_id) return false;

  try {
    const { data: page, error: pageErr } = await db
      .from("facebook_page")
      .select("access_token")
      .eq("page_id", first.page_id)
      .maybeSingle();
    if (pageErr) throw new Error(pageErr.message);
    if (!page) throw new Error(`Không tìm thấy page ${first.page_id}`);

    await updateComment(first.fb_comment_id, decryptToken(page.access_token), message);
    await db.from("scheduled_comment").update({ message }).eq("id", first.id);
    return true;
  } catch (e) {
    console.error(`[comments] sửa comment ${first.id} để gắn link WP lỗi: ${fmtError(e)}`);
    return false;
  }
}

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

// PENDING quá ngần này giờ mà bài vẫn chưa reconcile thì GHI CẢNH BÁO — KHÔNG bỏ cuộc. Mốc này
// trước đây đánh FAILED, nhưng sync-pages giờ chạy TAY: bài lên sóng thật vẫn có thể chưa reconcile
// trong DB sau 24h, và comment bị giết oan. Nay row ở lại PENDING vô thời hạn và tự gửi ở lượt quét
// đầu tiên sau khi post reconcile. Nằm chờ lâu KHÔNG tốn egress: vế post!inner ở processDueComments
// vẫn lọc hẳn nhóm chưa reconcile ra khỏi vòng claim/nhả (nguyên nhân sự cố ~20.000 request cũ).
const PENDING_WARN_HOURS = 24;

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
): Promise<{ sent: number; failed: number; retried: number; skipped: number; scanned: number; stalled: number }> {
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

  const res = { sent: 0, failed: 0, retried: 0, skipped: 0, scanned: pendRows.length + staleRows.length, stalled: 0 };
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

  res.stalled = await flagStalled(db, now, limit);
  return res;
}

/**
 * Gắn CẢNH BÁO lên những comment mà bài gắn với nó vẫn chưa reconcile sau PENDING_WARN_HOURS giờ
 * (reel chưa lên sóng thật, hoặc chỉ là chưa ai bấm đồng bộ). Vế post!inner ở processDueComments cố
 * tình không nhặt chúng lên, nên nếu không có lượt quét này thì chúng nằm PENDING im lặng.
 *
 * KHÔNG đụng tới status — đó là điểm khác bản cũ: trước đây mốc này đánh FAILED, tức comment mất
 * hẳn và phải bấm thử lại tay; nay row ở lại PENDING và tự gửi ở lượt quét đầu tiên sau khi post
 * reconcile, dù muộn bao lâu.
 *
 * Rẻ và KHÔNG lặp: điều kiện `error is null` khiến mỗi row chỉ bị PATCH đúng 1 lần trong đời, nên
 * một hàng đợi nằm chờ hàng tuần vẫn chỉ tốn 1 GET (thường rỗng) mỗi lượt cron.
 */
async function flagStalled(db: SupabaseClient, now: number, limit: number): Promise<number> {
  const cutoff = new Date(now - PENDING_WARN_HOURS * 3600_000).toISOString();
  const { data } = await db
    .from("scheduled_comment")
    .select("id, post!inner(fb_post_id)")
    .eq("status", "PENDING")
    .lte("run_after", cutoff)
    .is("error", null)
    .not("post.fb_post_id", "like", RECONCILED)
    .limit(limit);
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (!ids.length) return 0;

  const { error } = await db
    .from("scheduled_comment")
    .update({
      error:
        `Quá ${PENDING_WARN_HOURS}h kể từ giờ hẹn mà bài vẫn chưa lên sóng (fb_post_id còn là ` +
        `video-id lên lịch, chưa reconcile). Comment VẪN NẰM CHỜ và sẽ tự gửi ngay khi bài ` +
        `reconcile — bấm "Đồng bộ" nếu bài đã lên sóng rồi.`,
    })
    .in("id", ids)
    .eq("status", "PENDING");
  if (error) {
    console.error(`[comments] gắn cảnh báo cho ${ids.length} comment chờ lâu lỗi: ${error.message}`);
    return 0;
  }
  return ids.length;
}
