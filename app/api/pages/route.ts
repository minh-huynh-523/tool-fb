import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { encryptToken } from "@/lib/crypto";
import { getPageInfo, FacebookError } from "@/lib/facebook/client";
import { listPages } from "@/lib/queries";

export const runtime = "nodejs";

// GET /api/pages — list page (không trả access_token)
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  try {
    return NextResponse.json({ pages: await listPages() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// POST /api/pages — thêm/cập nhật 1 page: { page_id, name?, access_token }
// Xác thực token với FB trước khi lưu (né lưu token chết); tự lấy name/picture nếu thiếu.
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  let body: { page_id?: string; name?: string; access_token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const pageId = body.page_id?.trim();
  const accessToken = body.access_token?.trim();
  if (!pageId || !accessToken) {
    return NextResponse.json({ error: "Thiếu page_id hoặc access_token" }, { status: 400 });
  }

  // Xác thực token + lấy name/picture
  let info: { id: string; name: string; pictureUrl: string | null };
  try {
    info = await getPageInfo(pageId, accessToken);
  } catch (e) {
    const msg =
      e instanceof FacebookError
        ? `Token không hợp lệ: [FB ${e.code ?? ""}] ${e.message}`
        : (e as Error).message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from("facebook_page")
    .upsert(
      {
        page_id: pageId,
        name: body.name?.trim() || info.name,
        picture: info.pictureUrl,
        access_token: encryptToken(accessToken),
      },
      { onConflict: "page_id" },
    )
    .select("id, page_id, name, picture, token_expires_at, created_at, updated_at")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ page: data });
}
