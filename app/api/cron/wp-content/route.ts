import { NextRequest, NextResponse } from "next/server";
import { processWpContentQueue } from "@/lib/auto-publish";

export const runtime = "nodejs";
export const maxDuration = 90;

// GET|POST /api/cron/wp-content — Stage 2 của auto-publish (xem lib/auto-publish.ts): rút
// wp_content_queue, gọi Gemini sinh title/nội dung/ảnh cho từng bài, xong thì bắc cầu sang
// wp_publish_queue.
//
// KHÔNG CÒN LÀ ĐƯỜNG CHÍNH: 2 cron này (cùng /api/cron/wp-publish) tốn CPU/Memory nhiều nhất
// trong app, từng khiến Vercel Hobby bị PAUSE vì vượt quota — đã chuyển sang chạy bằng Supabase
// Edge Function (supabase/functions/wp-content) + pg_cron ngay trong Supabase (migration 0025),
// không đụng gì tới Vercel nữa. Route này GIỮ LẠI làm lối vào thủ công/debug (gọi tay qua curl
// khi cần soi lỗi), không nên trỏ cron ngoài vào đây nữa.
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
    const result = await processWpContentQueue();
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
