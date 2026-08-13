import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// POST /api/posts/[postDbId]/auto-publish/retry — bấm tay "Thử lại" khi 1 bài kẹt FAILED ở
// auto-publish (xem lib/auto-publish.ts). Reset status=PENDING + attempts=0 + error=null cho
// đúng hàng đang FAILED (wp_publish_queue trước — giai đoạn sau — rồi mới tới wp_content_queue),
// để cron tương ứng nhặt lại NGAY lượt sau, không cần đợi enqueue lại từ /wp-needed.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ postDbId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  const { postDbId } = await params;

  const db = createSupabaseAdmin();
  const reset = { status: "PENDING", attempts: 0, error: null, claimed_at: null };

  const { data: publishRow, error: pubErr } = await db
    .from("wp_publish_queue")
    .update(reset)
    .eq("post_id", postDbId)
    .eq("status", "FAILED")
    .select("id")
    .maybeSingle();
  if (pubErr) return NextResponse.json({ error: pubErr.message }, { status: 500 });
  if (publishRow) return NextResponse.json({ ok: true, stage: "publish" });

  const { data: contentRow, error: contErr } = await db
    .from("wp_content_queue")
    .update(reset)
    .eq("post_id", postDbId)
    .eq("status", "FAILED")
    .select("id")
    .maybeSingle();
  if (contErr) return NextResponse.json({ error: contErr.message }, { status: 500 });
  if (contentRow) return NextResponse.json({ ok: true, stage: "content" });

  return NextResponse.json({ error: "Bài này không ở trạng thái lỗi auto-publish" }, { status: 404 });
}
