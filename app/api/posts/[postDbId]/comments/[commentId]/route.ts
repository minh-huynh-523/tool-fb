import { NextRequest, NextResponse, after } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { drainOne } from "@/lib/comments";
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

  let body: { runAt?: string; message?: string; attachmentUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
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
    const runAt = body.runAt.trim();
    if (runAt) {
      const iso = vnLocalToISO(runAt);
      if (Number.isNaN(new Date(iso).getTime())) {
        return NextResponse.json({ error: "Giờ hẹn không hợp lệ" }, { status: 400 });
      }
      update.run_after = iso;
    } else {
      update.run_after = new Date().toISOString();
    }
  }
  if (body.message !== undefined) update.message = body.message.trim();
  if (body.attachmentUrl !== undefined) update.attachment_url = body.attachmentUrl.trim() || null;

  // Sau update phải còn nội dung hoặc link.
  const finalMessage = (update.message as string | undefined) ?? row.message;
  const finalAttachment = (update.attachment_url as string | null | undefined) ?? row.attachment_url;
  if (!finalMessage && !finalAttachment) {
    return NextResponse.json({ error: "Cần nội dung hoặc link đính kèm" }, { status: 400 });
  }

  // FAILED -> cho chạy lại với lịch mới.
  if (row.status === "FAILED") {
    update.status = "PENDING";
    update.error = null;
    update.claimed_at = null;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Không có gì để cập nhật" }, { status: 400 });
  }

  const { data: updated, error: upErr } = await db
    .from("scheduled_comment")
    .update(update)
    .eq("id", commentId)
    .eq("status", row.status) // optimistic: tránh đè khi worker vừa claim
    .select()
    .maybeSingle();
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
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
