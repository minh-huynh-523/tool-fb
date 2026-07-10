import { NextRequest, NextResponse } from "next/server";
import { processDueComments } from "@/lib/comments";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/cron/process-comments — safety-net, gọi bởi cron ngoài (cron-job.org).
// Bảo vệ bằng CRON_SECRET (header x-cron-secret hoặc ?secret=). KHÔNG qua Supabase Auth.
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // chưa cấu hình -> từ chối
  const header = req.headers.get("x-cron-secret");
  const auth = req.headers.get("authorization"); // hỗ trợ "Bearer <secret>"
  const query = req.nextUrl.searchParams.get("secret");
  return header === secret || auth === `Bearer ${secret}` || query === secret;
}

async function run(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await processDueComments();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return run(req);
}

// GET cho tiện cấu hình cron-job.org (nhiều dịch vụ chỉ gọi GET).
export async function GET(req: NextRequest) {
  return run(req);
}
