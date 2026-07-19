import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { generatePrompts, PromptError } from "@/lib/competitor-prompt";

export const runtime = "nodejs";
// Một lần gọi Gemini với mega-prompt + caption có thể mất 30-60s.
export const maxDuration = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/competitors/posts/[postId]/prompt
// Sinh prompt ảnh + prompt video từ caption bài đối thủ. Bấm lại = sinh lại (ghi đè).
// CỐ Ý không có route batch: N bài × ~30-60s sẽ vượt maxDuration và mất sạch tiến độ khi
// timeout — chạy hàng loạt do client điều phối, gọi lặp chính route này.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postId } = await params;
  if (!UUID_RE.test(postId)) {
    return NextResponse.json({ error: "postId không hợp lệ" }, { status: 400 });
  }

  try {
    const result = await generatePrompts(postId);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof PromptError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
