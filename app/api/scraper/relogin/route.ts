import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 phút — chỉ có tác dụng nếu deploy Vercel Pro; local dev không giới hạn

// POST /api/scraper/relogin — mở Chrome headful THẬT trên máy đang chạy Next.js, chờ tự phát
// hiện đăng nhập xong (cookie c_user) rồi lưu storageState. CHỈ dùng được khi chạy `npm run dev`
// ở máy có màn hình — Vercel không có GUI để mở browser, chặn sớm cho rõ ràng thay vì để
// chromium.launch() throw lỗi khó hiểu.
export async function POST() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  if (process.env.VERCEL) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "Không chạy được trên Vercel (không có màn hình để mở Chrome). Chạy `npm run dev` ở máy có màn hình rồi bấm nút này, hoặc chạy tay `npm run fb-login`.",
      },
      { status: 400 },
    );
  }

  const { runFbLogin } = await import("@/lib/fb-scraper/login");
  try {
    const result = await runFbLogin();
    return NextResponse.json(result, { status: result.ok ? 200 : 408 });
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 500 });
  }
}
