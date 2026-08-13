import { NextRequest, NextResponse } from "next/server";
import { processWpPublishQueue } from "@/lib/auto-publish";

export const runtime = "nodejs";
export const maxDuration = 90;

// GET|POST /api/cron/wp-publish — Stage 3 của auto-publish (xem lib/auto-publish.ts): rút
// wp_publish_queue (đã có title/nội dung/ảnh do Stage 2 sinh sẵn), đăng bài WordPress rồi comment
// "Full story: {permalink}" vào bài FB gốc.
//
// KHÔNG CÒN LÀ ĐƯỜNG CHÍNH: cùng lý do với /api/cron/wp-content — đã chuyển sang Supabase Edge
// Function (supabase/functions/wp-publish) + pg_cron (migration 0025) để không tốn quota Vercel.
// Route này GIỮ LẠI làm lối vào thủ công/debug, không nên trỏ cron ngoài vào đây nữa.
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("x-cron-secret");
  const auth = req.headers.get("authorization");
  const query = req.nextUrl.searchParams.get("secret");
  return header === secret || auth === `Bearer ${secret}` || query === secret;
}

async function run(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await processWpPublishQueue();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return run(req);
}

export async function GET(req: NextRequest) {
  return run(req);
}
