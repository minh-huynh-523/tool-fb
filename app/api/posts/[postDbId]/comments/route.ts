import { NextRequest, NextResponse, after } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { drainOne } from "@/lib/comments";
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

  let body: { message?: string; attachmentUrl?: string; runAt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  const attachmentUrl = (body.attachmentUrl ?? "").trim();
  const runAt = (body.runAt ?? "").trim(); // "YYYY-MM-DDTHH:mm" giờ VN — user tự hẹn giờ
  if (!message && !attachmentUrl) {
    return NextResponse.json({ error: "Cần nhập nội dung hoặc link đính kèm" }, { status: 400 });
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
  if (!p.is_published && !p.scheduled_publish_time && !runAt) {
    return NextResponse.json(
      { error: 'Bài này đang lên lịch nhưng chưa rõ giờ đăng — hãy chọn "Đăng comment lúc" (sau giờ bài lên sóng).' },
      { status: 400 },
    );
  }

  // run_after quyết định thời điểm worker gửi comment:
  // 1) User tự hẹn giờ (runAt) -> đúng giờ đó (giờ VN).
  // 2) Bài lên lịch (chưa publish) -> giờ lên lịch + delay (comment vào bài chưa publish sẽ fail).
  // 3) Bài đã đăng -> publish_at (fb_created_at) + delay.
  let runAfter: string;
  if (runAt) {
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
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  const row = inserted as ScheduledCommentRow;

  // Rút hàng đợi ngay sau khi trả response (không chặn request).
  after(async () => {
    try {
      await drainOne(row.id);
    } catch {
      // để cron xử lý lại
    }
  });

  return NextResponse.json({ queued: true, comment: row, runAfter });
}
