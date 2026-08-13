import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { enqueueWpContentCandidates, processWpContentQueue, processWpPublishQueue } from "@/lib/auto-publish";
import { startOfDayVNISO, endOfDayVNISO } from "@/lib/date";

export const runtime = "nodejs";
// 3 bước liền: enqueue (rẻ) + sinh nội dung Gemini + đăng WordPress/comment FB (đắt nhất) —
// nhiều thời gian hơn 1 cron đơn lẻ (sync-pages/wp-content/wp-publish đang là 60-90s mỗi cái).
export const maxDuration = 180;

// POST /api/auto-publish/run[?date=YYYY-MM-DD] — bấm tay từ UI (trang /prompts, nút "Chạy
// auto-publish ngay"): chạy CẢ 3 bước của lib/auto-publish.ts NGAY, không cần đợi cron ngoài
// (cron-job.org). ĐĂNG THẬT lên WordPress + comment THẬT lên Facebook cho các bài đủ điều kiện
// (tối đa vài bài/lượt, xem BATCH_LIMIT trong lib/auto-publish.ts). Bảo vệ bằng session đăng nhập
// (giống mọi route UI khác) — KHÔNG dùng CRON_SECRET, cái đó dành cho cron ngoài gọi.
//
// `date`: override cửa sổ mặc định "hôm nay từ giờ cắt" (todaySinceCutoff) để backfill 1 NGÀY
// trong quá khứ (nút "Chạy cho ngày cụ thể" ở /prompts) — vẫn CÙNG NGƯỠNG reaction/comment với
// đường chạy tự động thường ngày, chỉ khác cửa sổ thời gian xét bài.
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const date = req.nextUrl.searchParams.get("date");
  const window = date ? { fromIso: startOfDayVNISO(date), toIso: endOfDayVNISO(date) } : undefined;

  try {
    const enqueue = await enqueueWpContentCandidates(undefined, window);
    const content = await processWpContentQueue();
    const publish = await processWpPublishQueue();
    return NextResponse.json({ ok: true, enqueue, content, publish });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
