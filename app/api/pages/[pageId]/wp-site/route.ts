import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { encryptToken } from "@/lib/crypto";

export const runtime = "nodejs";

// Chuỗi rỗng = xoá cấu hình (quay về env mặc định) -> lưu null.
function normalize(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

// PATCH /api/pages/[pageId]/wp-site — cấu hình site WordPress riêng cho page:
// { wp_xmlrpc_url?, wp_base_url?, wp_category?, wp_user?, wp_password? }. Không đụng access_token.
//
// wp_password đi vào DB đã mã hoá AES-256-GCM (lib/crypto.ts) và KHÔNG BAO GIỜ đọc ngược ra qua
// API — response chỉ trả cờ wp_has_password. Vì client không thấy mật khẩu cũ nên nó cũng không
// gửi lại được: để trống ô password = GIỮ mật khẩu đang lưu, xoá username = xoá cả cặp.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { pageId } = await params;

  let body: {
    wp_xmlrpc_url?: string;
    wp_base_url?: string;
    wp_category?: string;
    wp_user?: string;
    wp_password?: string;
  };
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

  const wpUser = normalize(body.wp_user);
  const wpPassword = normalize(body.wp_password);

  // Mật khẩu cũ chỉ đọc để biết CÓ hay KHÔNG (giữ nguyên khi client bỏ trống ô password) — giá trị
  // đã mã hoá không rời khỏi route này.
  const { data: current, error: curErr } = await db
    .from("facebook_page")
    .select("wp_password_enc")
    .eq("page_id", pageId)
    .maybeSingle();
  if (curErr) return NextResponse.json({ error: curErr.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "Không tìm thấy page" }, { status: 404 });

  let passwordEnc: string | null;
  if (!wpUser) {
    passwordEnc = null; // xoá username = xoá cả cặp, page quay về credential chung ở env
  } else if (wpPassword) {
    passwordEnc = encryptToken(wpPassword);
  } else if (current.wp_password_enc) {
    passwordEnc = current.wp_password_enc; // giữ mật khẩu đang lưu
  } else {
    return NextResponse.json(
      { error: "Đã nhập username WordPress thì phải nhập cả mật khẩu" },
      { status: 400 },
    );
  }

  const { data, error } = await db
    .from("facebook_page")
    .update({
      wp_xmlrpc_url: xmlrpcUrl,
      wp_base_url: baseUrl,
      wp_category: normalize(body.wp_category),
      wp_user: wpUser,
      wp_password_enc: passwordEnc,
    })
    .eq("page_id", pageId)
    .select("page_id, wp_xmlrpc_url, wp_base_url, wp_category, wp_user, wp_password_enc")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Không tìm thấy page" }, { status: 404 });

  const { wp_password_enc, ...safe } = data;
  return NextResponse.json({ page: { ...safe, wp_has_password: Boolean(wp_password_enc) } });
}
