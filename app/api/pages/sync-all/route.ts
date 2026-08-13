import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { callEdgeFunction } from "@/lib/edge-functions";

export const runtime = "nodejs";
export const maxDuration = 60;

// Khớp SyncResult của supabase/functions/_shared/sync.ts (logic đồng bộ thật giờ chạy ở đó, xem
// CLAUDE.md — Vercel chỉ còn là UI). Định nghĩa lại tại đây vì lib/sync.ts (bản Node) đã bị xoá.
interface SyncResult {
  pageId: string;
  name?: string;
  count: number;
  scheduledCount?: number;
  ok: boolean;
  error?: string;
  warning?: string;
}

// POST /api/pages/sync-all — proxy mỏng: check session rồi gọi Edge Function sync-pages.
export async function POST() {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;
  try {
    const { status, data } = await callEdgeFunction<{ results?: SyncResult[]; total?: number; error?: string }>(
      "sync-pages",
      {},
    );
    if (status >= 400) {
      return NextResponse.json({ error: data.error ?? "Sync thất bại" }, { status });
    }
    return NextResponse.json({ results: data.results, total: data.total });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
