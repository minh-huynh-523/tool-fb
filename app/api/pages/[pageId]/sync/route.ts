import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { syncPage } from "@/lib/sync";

export const runtime = "nodejs";
export const maxDuration = 30;

// POST /api/pages/[pageId]/sync — đồng bộ feed 1 page.
export async function POST(_req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { pageId } = await params;
  try {
    const result = await syncPage(pageId);
    return NextResponse.json({ result }, { status: result.ok ? 200 : 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
