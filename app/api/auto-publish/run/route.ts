import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { callEdgeFunction } from "@/lib/edge-functions";
import { startOfDayVNISO, endOfDayVNISO } from "@/lib/date";

export const runtime = "nodejs";
// 3 lượt gọi Edge Function liền: enqueue (rẻ) + sinh nội dung Gemini + đăng WordPress/comment FB
// (đắt nhất) — nới hơn 1 cron đơn lẻ vì cộng dồn cả 3.
export const maxDuration = 180;

// POST /api/auto-publish/run[?date=YYYY-MM-DD] — bấm tay từ UI (trang /prompts, nút "Chạy
// auto-publish ngay"): proxy mỏng, gọi liền 3 Edge Function (auto-publish-enqueue, wp-content,
// wp-publish — xem supabase/functions/**) thay vì tự chạy lib/auto-publish.ts (đã xoá, Vercel chỉ
// còn là UI, xem CLAUDE.md). ĐĂNG THẬT lên WordPress + comment THẬT lên Facebook cho các bài đủ
// điều kiện. Bảo vệ bằng session đăng nhập — KHÔNG dùng CRON_SECRET (dành cho pg_cron).
//
// `date`: override cửa sổ mặc định "hôm nay từ giờ cắt" để backfill 1 NGÀY trong quá khứ (nút
// "Chạy cho ngày cụ thể" ở /prompts) — vẫn CÙNG NGƯỠNG reaction/comment với đường tự động thường
// ngày, chỉ khác cửa sổ thời gian xét bài.
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const date = req.nextUrl.searchParams.get("date");
  const window = date ? { fromIso: startOfDayVNISO(date), toIso: endOfDayVNISO(date) } : undefined;

  try {
    const enqueueRes = await callEdgeFunction("auto-publish-enqueue", { window });
    if (enqueueRes.status >= 400) {
      return NextResponse.json({ error: (enqueueRes.data as { error?: string }).error ?? "Enqueue thất bại" }, { status: 500 });
    }
    const contentRes = await callEdgeFunction("wp-content", {});
    const publishRes = await callEdgeFunction("wp-publish", {});
    return NextResponse.json({ ok: true, enqueue: enqueueRes.data, content: contentRes.data, publish: publishRes.data });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
