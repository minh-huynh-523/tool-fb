import { NextRequest, NextResponse, after } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { callEdgeFunction } from "@/lib/edge-functions";
import { FB_COMMENT_MAX_CHARS } from "@/lib/constants";
import { vnLocalToISO } from "@/lib/date";
import type { PostRow, ScheduledCommentRow } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

// Delay (ms) cộng vào publish_at. Mặc định 5s.
function commentDelayMs(): number {
  const v = Number(process.env.COMMENT_DELAY_MS ?? 5000);
  if (!Number.isFinite(v) || v < 0) return 5000;
  return v;
}

// POST /api/posts/[postDbId]/comments
// ENQUEUE (không chờ): run_after = publish_at(fb_created_at) + COMMENT_DELAY_MS.
// Rút hàng đợi ngay sau response bằng after(); cron là worker/lưới an toàn.
export async function POST(req: NextRequest, { params }: { params: Promise<{ postDbId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postDbId } = await params;

  let body: { message?: string; attachmentUrl?: string; runAt?: string; runAtISO?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  const attachmentUrl = (body.attachmentUrl ?? "").trim();
  const runAt = (body.runAt ?? "").trim(); // "YYYY-MM-DDTHH:mm" giờ VN — user tự hẹn giờ
  const runAtISO = (body.runAtISO ?? "").trim(); // ISO timestamptz — copy chính xác run_after của comment khác
  if (!message && !attachmentUrl) {
    return NextResponse.json({ error: "Cần nhập nội dung hoặc link đính kèm" }, { status: 400 });
  }
  // Chặn ở server là lớp bảo vệ CHÍNH (bộ đếm ở form chỉ là tiện lợi): quá trần thì FB nhận
  // rồi mới từ chối lúc gửi — người dùng chỉ thấy dòng đỏ nhiều giờ sau.
  if (message.length > FB_COMMENT_MAX_CHARS) {
    return NextResponse.json(
      {
        error: `Comment vượt quá ${FB_COMMENT_MAX_CHARS.toLocaleString("vi-VN")} ký tự (hiện tại: ${message.length.toLocaleString("vi-VN")}) — Facebook sẽ từ chối.`,
      },
      { status: 400 },
    );
  }

  const db = createSupabaseAdmin();
  const { data: post, error: postErr } = await db
    .from("post")
    .select("id, fb_post_id, page_id, fb_created_at, is_published, scheduled_publish_time")
    .eq("id", postDbId)
    .maybeSingle();
  if (postErr) return NextResponse.json({ error: postErr.message }, { status: 500 });
  if (!post) return NextResponse.json({ error: "Không tìm thấy post" }, { status: 404 });

  const p = post as Pick<
    PostRow,
    "id" | "fb_post_id" | "page_id" | "fb_created_at" | "is_published" | "scheduled_publish_time"
  >;

  // Bài lên lịch Business Suite: biết bài tồn tại nhưng KHÔNG biết giờ đăng (Meta không expose)
  // -> bắt buộc user tự chọn giờ, nếu không comment sẽ bắn ngay vào bài chưa lên sóng và fail.
  if (!p.is_published && !p.scheduled_publish_time && !runAt && !runAtISO) {
    return NextResponse.json(
      { error: 'Bài này đang lên lịch nhưng chưa rõ giờ đăng — hãy chọn "Đăng comment lúc" (sau giờ bài lên sóng).' },
      { status: 400 },
    );
  }

  // run_after quyết định thời điểm worker gửi comment:
  // 0) runAtISO -> dùng nguyên ISO (copy chính xác run_after của comment khác, không mất giây).
  // 1) User tự hẹn giờ (runAt) -> đúng giờ đó (giờ VN).
  // 2) Bài lên lịch (chưa publish) -> giờ lên lịch + delay (comment vào bài chưa publish sẽ fail).
  // 3) Bài đã đăng -> publish_at (fb_created_at) + delay.
  let runAfter: string;
  if (runAtISO) {
    const t = new Date(runAtISO).getTime();
    if (Number.isNaN(t)) {
      return NextResponse.json({ error: "Giờ hẹn (ISO) không hợp lệ" }, { status: 400 });
    }
    runAfter = new Date(t).toISOString();
  } else if (runAt) {
    const iso = vnLocalToISO(runAt);
    if (Number.isNaN(new Date(iso).getTime())) {
      return NextResponse.json({ error: "Giờ hẹn không hợp lệ" }, { status: 400 });
    }
    runAfter = iso;
  } else {
    const baseMs =
      !p.is_published && p.scheduled_publish_time
        ? new Date(p.scheduled_publish_time).getTime()
        : p.fb_created_at
          ? new Date(p.fb_created_at).getTime()
          : Date.now();
    runAfter = new Date(baseMs + commentDelayMs()).toISOString();
  }

  // CHẶN TRÙNG. Nguồn thật sự của bug "FB hiện 2 comment giống hệt": hàng đợi bị nạp 2 lần
  // (bấm ở 2 chỗ với dữ liệu cũ, mở 2 tab, chạy lại batch), KHÔNG phải worker gửi lặp — 8 cặp
  // trùng trong DB đều attempts=0 và có fb_comment_id khác nhau.
  // Guard client-side (nút disable, badge "Đã lên lịch") không đủ: nó đọc props có thể đã cũ.
  // FAILED không tính là trùng — bài fail thì phải lên lịch lại được y hệt.
  const dupQuery = db
    .from("scheduled_comment")
    .select("id, status, run_after, sent_at")
    .eq("post_id", p.id)
    .eq("message", message)
    .neq("status", "FAILED");
  const { data: dup, error: dupErr } = await (
    attachmentUrl ? dupQuery.eq("attachment_url", attachmentUrl) : dupQuery.is("attachment_url", null)
  )
    .limit(1)
    .maybeSingle();
  if (dupErr) return NextResponse.json({ error: dupErr.message }, { status: 500 });
  if (dup) {
    const d = dup as Pick<ScheduledCommentRow, "id" | "status" | "run_after" | "sent_at">;
    return NextResponse.json(
      {
        error:
          d.status === "SENT"
            ? "Comment y hệt đã ĐĂNG cho bài này rồi — thêm nữa là Facebook hiện 2 comment trùng."
            : "Comment y hệt đang chờ đăng cho bài này rồi.",
        duplicate: true,
        existing: d,
      },
      { status: 409 },
    );
  }

  const { data: inserted, error: insErr } = await db
    .from("scheduled_comment")
    .insert({
      post_id: p.id,
      fb_post_id: p.fb_post_id,
      page_id: p.page_id,
      message,
      attachment_url: attachmentUrl || null,
      run_after: runAfter,
      status: "PENDING",
    })
    .select()
    .single();
  // 23505 = unique violation của scheduled_comment_no_dup_idx (migration 0019): hai request
  // đồng thời cùng lọt qua vòng kiểm tra ở trên. Đây là chốt atomic, không phải lỗi hệ thống.
  if (insErr) {
    if (insErr.code === "23505") {
      return NextResponse.json(
        { error: "Comment y hệt vừa được thêm cho bài này (bấm 2 lần?) — không thêm nữa.", duplicate: true },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  const row = inserted as ScheduledCommentRow;

  // Rút hàng đợi ngay sau khi trả response (không chặn request) — gọi Edge Function
  // process-comments (xử lý thật nằm ở supabase/functions/**, Vercel chỉ còn là UI).
  after(async () => {
    try {
      await callEdgeFunction("process-comments", { commentId: row.id });
    } catch {
      // để pg_cron xử lý lại (fb-dashboard-process-comments, mỗi 2 phút)
    }
  });

  return NextResponse.json({ queued: true, comment: row, runAfter });
}
