import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { countPostsNeedingWp, envThresholds } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/wp-needed/count — số bài đang chờ đăng link WP, cho badge ở sidebar poll mỗi 60s.
// CỐ Ý dùng ngưỡng từ env chứ không nhận ngưỡng qua query: badge phải nói cùng một con số ở mọi
// tab, mọi lúc. Muốn xem thử ngưỡng khác thì dùng ?r=&c= trên trang /wp-needed.
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  try {
    return NextResponse.json({ count: await countPostsNeedingWp(envThresholds()) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
