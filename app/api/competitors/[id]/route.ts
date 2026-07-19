import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// PATCH /api/competitors/[id] — cập nhật:
//   { requestScrape: true }  -> đặt scrape_requested_at = now() (nút "Cào ngay"; worker laptop poll sẽ nhận)
//   { active: boolean }      -> bật/tắt theo dõi page
//   { sheetCopied: true }    -> đánh dấu đã copy sang Sheet (set sheet_copied_at = now())
// Route này KHÔNG chạy browser (Vercel không cào) — chỉ ghi cờ vào DB.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  const { id } = await params;

  let body: { requestScrape?: boolean; active?: boolean; sheetCopied?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (body.requestScrape) patch.scrape_requested_at = new Date().toISOString();
  if (typeof body.active === "boolean") patch.active = body.active;
  if (body.sheetCopied) patch.sheet_copied_at = new Date().toISOString();
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Không có gì để cập nhật" }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { data, error } = await db.from("competitor_page").update(patch).eq("id", id).select("*").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Không thấy page" }, { status: 404 });
  return NextResponse.json({ page: data });
}

// DELETE /api/competitors/[id] — xoá page khỏi danh sách theo dõi (cascade post/comment)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  const { id } = await params;

  const db = createSupabaseAdmin();
  const { error } = await db.from("competitor_page").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
