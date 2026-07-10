import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "./session";

// Bảo vệ API route: trả 401 JSON nếu chưa đăng nhập (session cookie không hợp lệ).
export async function requireUser(): Promise<
  { ok: true } | { ok: false; res: NextResponse }
> {
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { ok: false, res: NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 }) };
  }
  return { ok: true };
}
