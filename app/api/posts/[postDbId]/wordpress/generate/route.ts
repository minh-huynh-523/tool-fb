import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { generateWpArticleFromFb, WpArticleGenError } from "@/lib/wp-article-gen";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/posts/[postDbId]/wordpress/generate
// BƯỚC 1 (nguồn "Từ caption FB + Part 2"): chỉ sinh để xem trước (title + ảnh + nội dung qua
// Gemini). KHÔNG đăng WP, KHÔNG ghi DB — đối xứng với .../wordpress/scrape (nguồn "dán link ngoài").
export async function POST(_req: NextRequest, { params }: { params: Promise<{ postDbId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postDbId } = await params;
  const db = createSupabaseAdmin();

  try {
    const a = await generateWpArticleFromFb(db, postDbId);
    return NextResponse.json({
      ok: true,
      title: a.title,
      imageUrl: a.imageUrl,
      description: a.description,
      contentHtml: a.contentHtml,
      parts: a.parts,
    });
  } catch (e) {
    if (e instanceof WpArticleGenError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
