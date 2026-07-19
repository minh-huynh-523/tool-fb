import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const MAX_BODY = 40_000;

// GET /api/prompt-templates — đọc mega-prompt hiện tại
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const db = createSupabaseAdmin();
  const { data, error } = await db.from("prompt_template").select("*").order("kind");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ templates: data ?? [] });
}

// PUT /api/prompt-templates — { kind: 'main', body } lưu mega-prompt.
// KHÔNG kiểm tra sự tồn tại của 3 heading ### ở đây: user có thể cố tình dùng format khác
// và vẫn copy được bản gốc. Form đã cảnh báo; parser fail-soft.
export async function PUT(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  let payload: { kind?: string; body?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const kind = payload.kind ?? "main";
  if (kind !== "main") {
    return NextResponse.json({ error: "kind không hợp lệ" }, { status: 400 });
  }
  const body = (payload.body ?? "").trim();
  if (!body) return NextResponse.json({ error: "Mẫu prompt không được để trống" }, { status: 400 });
  if (body.length > MAX_BODY) {
    return NextResponse.json({ error: `Mẫu prompt quá dài (tối đa ${MAX_BODY} ký tự)` }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from("prompt_template")
    .update({ body })
    .eq("kind", kind)
    .select("*")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Chưa có mẫu prompt — migration 0009 đã chạy chưa?" }, { status: 404 });
  return NextResponse.json({ template: data });
}
