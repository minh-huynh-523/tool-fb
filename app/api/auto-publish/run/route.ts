import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { enqueueWpContentCandidates, processWpContentQueue, processWpPublishQueue } from "@/lib/auto-publish";

export const runtime = "nodejs";
// 3 bước liền: enqueue (rẻ) + sinh nội dung Gemini + đăng WordPress/comment FB (đắt nhất) —
// nhiều thời gian hơn 1 cron đơn lẻ (sync-pages/wp-content/wp-publish đang là 60-90s mỗi cái).
export const maxDuration = 180;

// POST /api/auto-publish/run — bấm tay từ UI (trang /prompts, nút "Chạy auto-publish ngay"): chạy
// CẢ 3 bước của lib/auto-publish.ts NGAY, không cần đợi cron ngoài (cron-job.org). ĐĂNG THẬT lên
// WordPress + comment THẬT lên Facebook cho các bài đủ điều kiện (tối đa vài bài/lượt, xem
// BATCH_LIMIT trong lib/auto-publish.ts). Bảo vệ bằng session đăng nhập (giống mọi route UI khác)
// — KHÔNG dùng CRON_SECRET, cái đó dành cho cron ngoài gọi.
export async function POST() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  try {
    const enqueue = await enqueueWpContentCandidates();
    const content = await processWpContentQueue();
    const publish = await processWpPublishQueue();
    return NextResponse.json({ ok: true, enqueue, content, publish });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
