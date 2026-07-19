import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Chuỗi rỗng = xoá cấu hình (quay về env mặc định) -> lưu null.
function normalize(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

// PATCH /api/pages/[pageId]/wp-site — cấu hình site WordPress riêng cho page:
// { wp_xmlrpc_url?, wp_base_url?, wp_category? }. Không đụng tới access_token.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { pageId } = await params;

  let body: { wp_xmlrpc_url?: string; wp_base_url?: string; wp_category?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const xmlrpcUrl = normalize(body.wp_xmlrpc_url);
  const baseUrl = normalize(body.wp_base_url)?.replace(/\/+$/, "") ?? null;

  for (const [label, url] of [
    ["XML-RPC URL", xmlrpcUrl],
    ["Base URL", baseUrl],
  ] as const) {
    if (url && !/^https?:\/\/.+/i.test(url)) {
      return NextResponse.json({ error: `${label} phải bắt đầu bằng http:// hoặc https://` }, { status: 400 });
    }
  }

  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from("facebook_page")
    .update({
      wp_xmlrpc_url: xmlrpcUrl,
      wp_base_url: baseUrl,
      wp_category: normalize(body.wp_category),
    })
    .eq("page_id", pageId)
    .select("page_id, wp_xmlrpc_url, wp_base_url, wp_category")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Không tìm thấy page" }, { status: 404 });
  return NextResponse.json({ page: data });
}
