import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/crypto";
import { getPageInfo, FacebookError } from "@/lib/facebook/client";

export const runtime = "nodejs";

// GET /api/pages/[pageId]/test-token — gọi thử Graph để biết token còn sống.
export async function GET(_req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { pageId } = await params;
  const db = createSupabaseAdmin();
  const { data: page, error } = await db
    .from("facebook_page")
    .select("access_token")
    .eq("page_id", pageId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!page) return NextResponse.json({ error: "Không tìm thấy page" }, { status: 404 });

  try {
    const token = decryptToken((page as { access_token: string }).access_token);
    const info = await getPageInfo(pageId, token);
    return NextResponse.json({ ok: true, name: info.name });
  } catch (e) {
    const msg =
      e instanceof FacebookError
        ? `[FB ${e.code ?? ""}${e.subcode ? "/" + e.subcode : ""}] ${e.message}`
        : (e as Error).message;
    return NextResponse.json({ ok: false, error: msg }, { status: 200 });
  }
}
