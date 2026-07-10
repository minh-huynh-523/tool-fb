import { NextRequest, NextResponse } from "next/server";
import { syncAllPages } from "@/lib/sync";
import { processDueComments } from "@/lib/comments";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET|POST /api/cron/sync-pages — auto-sync bởi cron ngoài (cron-job.org), bảo vệ bằng CRON_SECRET.
// Sync (kéo bài mới + reconcile reel lên lịch vừa publish) RỒI drain comment tới hạn —
// một cron duy nhất khép kín luồng: reel lên sóng -> đổi id -> comment đăng đúng bài.
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
    const results = await syncAllPages({ limit: 25 });
    const comments = await processDueComments();
    return NextResponse.json({ ok: true, sync: results, comments });
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
