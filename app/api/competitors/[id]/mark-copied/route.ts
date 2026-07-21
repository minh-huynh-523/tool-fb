import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// POST /api/competitors/[id]/mark-copied
//   { postIds: string[], copied?: boolean }  -> set/xoá competitor_post.sheet_copied_at
// Nhờ đó lần copy sau không lấy lại mấy bài này (xem pickSheetRows trong lib/sheet-rows.ts).
//
// Lọc thêm .eq('competitor_page_id', id) dù postIds đã là khoá chính: id trong URL là thứ user
// sửa được, không có vế này thì một request thủ công đánh dấu chéo được bài của page khác.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  const { id } = await params;

  let body: { postIds?: unknown; copied?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const postIds = Array.isArray(body.postIds) ? body.postIds.filter((x): x is string => typeof x === "string") : [];
  if (postIds.length === 0) {
    return NextResponse.json({ error: "Thiếu postIds" }, { status: 400 });
  }
  const copied = body.copied !== false; // mặc định là đánh dấu ĐÃ copy

  const db = createSupabaseAdmin();
  const stamp = copied ? new Date().toISOString() : null;

  // Chia lô: postIds đi vào query string dạng in.(...), lô quá lớn sẽ vỡ giới hạn độ dài URL.
  const updated: string[] = [];
  for (let i = 0; i < postIds.length; i += 200) {
    const { data, error } = await db
      .from("competitor_post")
      .update({ sheet_copied_at: stamp })
      .eq("competitor_page_id", id)
      .in("id", postIds.slice(i, i + 200))
      .select("id");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    updated.push(...(data ?? []).map((r: { id: string }) => r.id));
  }

  return NextResponse.json({ updated: updated.length, copied });
}
