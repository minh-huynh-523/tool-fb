import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { scrapeArticle } from "@/lib/scrape";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/posts/[postDbId]/wordpress/scrape  { sourceUrl }
// BƯỚC 1: chỉ cào để xem trước (title + ảnh + trích đoạn). KHÔNG đăng WP, KHÔNG ghi DB.
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  let body: { sourceUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON không hợp lệ" }, { status: 400 });
  }
  const sourceUrl = (body.sourceUrl ?? "").trim();
  if (!sourceUrl) return NextResponse.json({ error: "Cần nhập link bài gốc" }, { status: 400 });

  try {
    const a = await scrapeArticle(sourceUrl);
    return NextResponse.json({
      ok: true,
      title: a.title,
      imageUrl: a.imageUrl,
      description: a.description,
      contentHtml: a.contentHtml, // full nội dung (đã gộp mọi phần) để validate trước khi đăng
      parts: a.parts,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
