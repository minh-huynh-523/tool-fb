import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { signSession, safeEqual, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session";

export const runtime = "nodejs";

// POST /api/auth/login — so khớp username/password với env, set cookie ký HMAC.
export async function POST(req: NextRequest) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }

  const U = process.env.DASHBOARD_USERNAME;
  const P = process.env.DASHBOARD_PASSWORD;
  if (!U || !P) {
    return NextResponse.json(
      { error: "Chưa cấu hình DASHBOARD_USERNAME / DASHBOARD_PASSWORD trong .env" },
      { status: 500 },
    );
  }

  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  if (!safeEqual(username, U) || !safeEqual(password, P)) {
    return NextResponse.json({ error: "Sai tài khoản hoặc mật khẩu" }, { status: 401 });
  }

  const token = await signSession({ u: username, iat: Date.now() });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return NextResponse.json({ ok: true });
}
