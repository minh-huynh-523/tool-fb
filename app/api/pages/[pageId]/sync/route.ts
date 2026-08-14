import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { callEdgeFunction } from "@/lib/edge-functions";

export const runtime = "nodejs";
export const maxDuration = 30;

// Khớp SyncResult của supabase/functions/_shared/sync.ts — xem app/api/pages/sync-all/route.ts.
interface SyncResult {
  pageId: string;
  name?: string;
  count: number;
  scheduledCount?: number;
  ok: boolean;
  error?: string;
  warning?: string;
}

// POST /api/pages/[pageId]/sync — proxy mỏng: gọi Edge Function sync-pages với { pageId } (chỉ
// sync 1 page — xem supabase/functions/sync-pages/index.ts).
export async function POST(_req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { pageId } = await params;
  try {
    const { status, data } = await callEdgeFunction<{ result?: SyncResult; error?: string }>("sync-pages", {
      pageId,
    });
    if (data.error) return NextResponse.json({ error: data.error }, { status: status >= 400 ? status : 500 });
    return NextResponse.json({ result: data.result }, { status: data.result?.ok ? 200 : 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
