import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { listCompetitorPages } from "@/lib/queries";

export const runtime = "nodejs";

// GET /api/competitors — list page đối thủ (kèm post_count)
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  try {
    return NextResponse.json({ pages: await listCompetitorPages() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// POST /api/competitors — thêm 1 handle mới: { handle, kind?, genre? }
// Chỉ ghi vào bảng; worker ở laptop sẽ cào (cần active=true + có VPN nếu geo-block).
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  let body: { handle?: string; kind?: string; genre?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  // Chấp nhận dán cả URL (facebook.com/xxx) — tự tách handle.
  const raw = body.handle?.trim() ?? "";
  const path = raw
    .replace(/^https?:\/\/(www\.|m\.|web\.)?facebook\.com\//i, "")
    .replace(/^\/+/, "");
  // profile.php phải bắt id TRƯỚC khi cắt query — cắt trước thì còn trơ lại "profile.php".
  // Query có thể còn tham số khác (vd ?id=123&locale=vi_VN) nên match id ở vị trí bất kỳ.
  const profileId = path.match(/^profile\.php\?(?:.*&)?id=(\d+)/i);
  const handle = profileId ? profileId[1] : path.replace(/\?.*$/, "").replace(/\/+$/, "");
  if (!handle) {
    return NextResponse.json({ error: "Thiếu handle (vanity hoặc ID số)" }, { status: 400 });
  }

  const kind = body.kind === "profile" ? "profile" : /^\d+$/.test(handle) && handle.startsWith("100") ? "profile" : "page";

  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from("competitor_page")
    .upsert(
      { handle, kind, active: true, genre: body.genre?.trim() || null },
      { onConflict: "handle", ignoreDuplicates: true },
    )
    .select("*")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ page: data, handle });
}
