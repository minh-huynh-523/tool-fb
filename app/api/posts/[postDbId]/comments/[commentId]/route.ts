import { NextRequest, NextResponse, after } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { drainOne } from "@/lib/comments";
import { FB_COMMENT_MAX_CHARS } from "@/lib/constants";
import { vnLocalToISO } from "@/lib/date";
import type { ScheduledCommentRow } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

// DELETE /api/posts/[postDbId]/comments/[commentId]
// Huỷ comment ĐÃ LÊN LỊCH (PENDING/FAILED). Đã gửi (SENT) hoặc đang gửi (PROCESSING) thì không xoá
// — SENT là lịch sử thật trên FB, PROCESSING đang trong tay worker.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ postDbId: string; commentId: string }> },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postDbId, commentId } = await params;
  const db = createSupabaseAdmin();

  const { data: found, error: findErr } = await db
    .from("scheduled_comment")
    .select("id, status")
    .eq("id", commentId)
    .eq("post_id", postDbId)
    .maybeSingle();
  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 });
  if (!found) return NextResponse.json({ error: "Không tìm thấy comment" }, { status: 404 });

  const status = (found as { status: string }).status;
  if (status !== "PENDING" && status !== "FAILED") {
    return NextResponse.json(
      { error: status === "SENT" ? "Comment đã đăng rồi — không xoá được." : "Comment đang gửi — không xoá được." },
      { status: 409 },
    );
  }

  // Optimistic: chỉ xoá khi status chưa đổi (tránh xoá lúc worker vừa claim sang PROCESSING).
  const { data: deleted, error: delErr } = await db
    .from("scheduled_comment")
    .delete()
    .eq("id", commentId)
    .eq("status", status)
    .select("id")
    .maybeSingle();
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  if (!deleted) {
    return NextResponse.json({ error: "Comment vừa được worker xử lý — tải lại trang để xem trạng thái." }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}

// PATCH /api/posts/[postDbId]/comments/[commentId]  { runAt?, message?, attachmentUrl? }
// Sửa comment ĐÃ LÊN LỊCH (đổi giờ/nội dung). Chỉ cho phép khi PENDING hoặc FAILED
// (FAILED -> sửa xong reset về PENDING để thử lại). Đã gửi (SENT/PROCESSING) thì không sửa được.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ postDbId: string; commentId: string }> },
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postDbId, commentId } = await params;

  let body: { runAt?: unknown; message?: unknown; attachmentUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }
  for (const k of ["runAt", "message", "attachmentUrl"] as const) {
    if (body[k] !== undefined && typeof body[k] !== "string") {
      return NextResponse.json({ error: `Trường ${k} phải là chuỗi` }, { status: 400 });
    }
  }

  const db = createSupabaseAdmin();
  const { data: found, error: findErr } = await db
    .from("scheduled_comment")
    .select("*")
    .eq("id", commentId)
    .eq("post_id", postDbId)
    .maybeSingle();
  if (findErr) return NextResponse.json({ error: findErr.message }, { status: 500 });
  if (!found) return NextResponse.json({ error: "Không tìm thấy comment" }, { status: 404 });

  const row = found as ScheduledCommentRow;
  if (row.status !== "PENDING" && row.status !== "FAILED") {
    return NextResponse.json(
      { error: row.status === "SENT" ? "Comment đã đăng rồi — không sửa được." : "Comment đang gửi — không sửa được." },
      { status: 409 },
    );
  }

  const update: Record<string, unknown> = {};

  // Giờ hẹn: "" = đăng ngay (run_after = now); có giá trị = giờ VN "YYYY-MM-DDTHH:mm".
  if (body.runAt !== undefined) {
    const runAt = (body.runAt as string).trim();
    if (runAt) {
      let iso: string;
      try {
        iso = vnLocalToISO(runAt);
      } catch {
        return NextResponse.json({ error: "Giờ hẹn không hợp lệ" }, { status: 400 });
      }
      if (Number.isNaN(new Date(iso).getTime())) {
        return NextResponse.json({ error: "Giờ hẹn không hợp lệ" }, { status: 400 });
      }
      update.run_after = iso;
    } else {
      // "Đăng ngay" — chặn với bài chưa lên sóng & chưa rõ giờ đăng (giống guard ở POST).
      const { data: post } = await db
        .from("post")
        .select("is_published, scheduled_publish_time")
        .eq("id", postDbId)
        .maybeSingle();
      const p = post as { is_published: boolean; scheduled_publish_time: string | null } | null;
      if (p && !p.is_published && !p.scheduled_publish_time) {
        return NextResponse.json(
          { error: 'Bài này đang lên lịch nhưng chưa rõ giờ đăng — hãy chọn "Đăng comment lúc" (sau giờ bài lên sóng).' },
          { status: 400 },
        );
      }
      update.run_after = new Date().toISOString();
    }
  }
  if (body.message !== undefined) update.message = (body.message as string).trim();
  if (body.attachmentUrl !== undefined) update.attachment_url = (body.attachmentUrl as string).trim() || null;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Không có gì để cập nhật" }, { status: 400 });
  }

  // Sau update phải còn nội dung hoặc link ("in" check — vì attachment_url có thể là null hợp lệ).
  const finalMessage = "message" in update ? (update.message as string) : row.message;
  const finalAttachment = "attachment_url" in update ? (update.attachment_url as string | null) : row.attachment_url;
  if (!finalMessage && !finalAttachment) {
    return NextResponse.json({ error: "Cần nội dung hoặc link đính kèm" }, { status: 400 });
  }
  if (finalMessage.length > FB_COMMENT_MAX_CHARS) {
    return NextResponse.json(
      {
        error: `Comment vượt quá ${FB_COMMENT_MAX_CHARS.toLocaleString("vi-VN")} ký tự (hiện tại: ${finalMessage.length.toLocaleString("vi-VN")}) — Facebook sẽ từ chối.`,
      },
      { status: 400 },
    );
  }

  // FAILED -> cho chạy lại với lịch mới (chỉ khi có thay đổi thật — check rỗng đã nằm phía trên).
  // attempts về 0: đây là lần thử lại DO NGƯỜI dùng bấm, reset bộ đếm để theo dõi lại từ đầu.
  if (row.status === "FAILED") {
    update.status = "PENDING";
    update.error = null;
    update.claimed_at = null;
    update.attempts = 0;
  }

  const { data: updated, error: upErr } = await db
    .from("scheduled_comment")
    .update(update)
    .eq("id", commentId)
    .eq("status", row.status) // optimistic: tránh đè khi worker vừa claim
    .select()
    .maybeSingle();
  // 23505 = đụng scheduled_comment_no_dup_idx (migration 0019): sửa xong thì row này trùng y hệt
  // một comment khác của cùng bài. Cả FAILED -> PENDING ở trên cũng có thể kích hoạt (row FAILED
  // nằm ngoài index, chuyển về PENDING là bước vào).
  if (upErr) {
    if (upErr.code === "23505") {
      return NextResponse.json(
        { error: "Bài này đã có comment y hệt (nội dung + link) — sửa vậy sẽ thành 2 comment trùng trên Facebook." },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "Comment vừa được worker xử lý — tải lại trang để xem trạng thái." }, { status: 409 });
  }

  // Nếu giờ mới đã tới hạn thì gửi luôn sau response (drainOne tự bỏ qua nếu chưa tới giờ).
  after(async () => {
    try {
      await drainOne(commentId);
    } catch {
      // để cron xử lý lại
    }
  });

  return NextResponse.json({ ok: true, comment: updated });
}
