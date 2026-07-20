import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// POST /api/posts/[postDbId]/wp-dismiss — bật/tắt "bỏ qua" bài này ở hàng đợi /wp-needed.
//   { dismissed: true }  -> wp_dismissed_at = now()  (bài rời hàng đợi, badge giảm)
//   { dismissed: false } -> wp_dismissed_at = null   (hoàn tác)
// KHÔNG đụng gì tới Facebook hay WordPress — chỉ là cờ "tôi đã cân nhắc bài này rồi".
export async function POST(req: NextRequest, { params }: { params: Promise<{ postDbId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  const { postDbId } = await params;

  let body: { dismissed?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }
  if (typeof body.dismissed !== "boolean") {
    return NextResponse.json({ error: "Thiếu trường `dismissed` (boolean)" }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from("post")
    .update({ wp_dismissed_at: body.dismissed ? new Date().toISOString() : null })
    .eq("id", postDbId)
    .select("id, wp_dismissed_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Không thấy bài" }, { status: 404 });
  return NextResponse.json({ post: data });
}
