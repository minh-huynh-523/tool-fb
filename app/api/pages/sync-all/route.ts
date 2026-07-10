import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { syncAllPages } from "@/lib/sync";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/pages/sync-all — đồng bộ tất cả page (tuần tự).
export async function POST() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  try {
    const results = await syncAllPages();
    const total = results.reduce((n, r) => n + r.count, 0);
    return NextResponse.json({ results, total });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
