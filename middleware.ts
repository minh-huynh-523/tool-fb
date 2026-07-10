import { NextResponse, type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/session";

// Guard route bằng cookie session (ký HMAC). Chạy ở edge runtime (dùng Web Crypto).
export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);

  const { pathname } = request.nextUrl;
  const isLogin = pathname === "/login";

  if (!session && !isLogin) {
    // API route: trả 401 JSON — redirect sang /login làm fetch của client nhận HTML
    // rồi nổ "Unexpected token '<' ... is not valid JSON" khi res.json().
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Phiên đăng nhập đã hết hạn — hãy tải lại trang." }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  if (session && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/posts";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    // Tất cả route TRỪ: /api/cron/*, /api/auth/* (login/logout), asset tĩnh, ảnh.
    "/((?!api/cron|api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
