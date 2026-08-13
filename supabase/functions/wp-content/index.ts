// Stage 2 của auto-publish (xem lib/auto-publish.ts bản Next.js — port Y HỆT logic sang Deno):
// rút wp_content_queue, gọi Gemini sinh title/nội dung/ảnh cho từng bài, xong thì bắc cầu sang
// wp_publish_queue. TÁCH riêng khỏi Stage 3 (WordPress + FB, xem function wp-publish) vì độ
// trễ/kiểu lỗi khác hẳn — 1 lượt Gemini không nên bị làm lại chỉ vì bước đăng WP/comment hỏng.
//
// Lên lịch bằng pg_cron trong chính Supabase (xem migration 0025) — KHÔNG còn chạy trên Vercel
// (route cũ app/api/cron/wp-content đã bị xoá, xem lib/auto-publish.ts để biết lý do chuyển).
import { createClient } from "npm:@supabase/supabase-js@2";
import { generateWpArticleFromFb, WpArticleGenError } from "../_shared/wp-article-gen.ts";

const STALE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const LIMIT = 5; // Edge Function có ngân sách thời gian riêng, thoải mái hơn 1 chút so với Vercel

interface Row {
  id: string;
  post_id: string;
  attempts: number;
}

const SELECT = "id, post_id, attempts";

async function claimPending(db: ReturnType<typeof createClient>, id: string): Promise<Row | null> {
  const { data, error } = await db
    .from("wp_content_queue")
    .update({ status: "PROCESSING", claimed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "PENDING")
    .select(SELECT)
    .maybeSingle();
  if (error) throw error;
  return (data as Row) ?? null;
}

async function reclaimProcessing(db: ReturnType<typeof createClient>, id: string, staleCutoffIso: string): Promise<Row | null> {
  const { data, error } = await db
    .from("wp_content_queue")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "PROCESSING")
    .lte("claimed_at", staleCutoffIso)
    .select(SELECT)
    .maybeSingle();
  if (error) throw error;
  return (data as Row) ?? null;
}

async function processRow(db: ReturnType<typeof createClient>, row: Row): Promise<"DONE" | "FAILED"> {
  try {
    const article = await generateWpArticleFromFb(db, row.post_id);
    await db
      .from("wp_content_queue")
      .update({
        status: "DONE",
        title: article.title,
        content_html: article.contentHtml,
        image_url: article.imageUrl,
        source_url: article.sourceUrl,
        error: null,
      })
      .eq("id", row.id)
      .eq("status", "PROCESSING");

    const { error: pubErr } = await db.from("wp_publish_queue").upsert(
      {
        post_id: row.post_id,
        title: article.title,
        content_html: article.contentHtml,
        image_url: article.imageUrl,
        source_url: article.sourceUrl,
      },
      { onConflict: "post_id", ignoreDuplicates: true },
    );
    if (pubErr) console.error(`wp_publish_queue insert lỗi cho post ${row.post_id}:`, pubErr.message);
    return "DONE";
  } catch (e) {
    const attempts = (row.attempts ?? 0) + 1;
    const msg = e instanceof WpArticleGenError ? e.message : e instanceof Error ? e.message : String(e);
    const status = attempts < MAX_ATTEMPTS ? "PENDING" : "FAILED";
    await db.from("wp_content_queue").update({ status, error: msg, attempts }).eq("id", row.id).eq("status", "PROCESSING");
    return "FAILED";
  }
}

Deno.serve(async (_req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const staleCutoff = new Date(Date.now() - STALE_MS).toISOString();

  const [{ data: pend }, { data: stale }] = await Promise.all([
    db.from("wp_content_queue").select(SELECT).eq("status", "PENDING").limit(LIMIT),
    db.from("wp_content_queue").select(SELECT).eq("status", "PROCESSING").lte("claimed_at", staleCutoff).limit(LIMIT),
  ]);

  let done = 0;
  let failed = 0;
  for (const row of (pend ?? []) as Row[]) {
    const claimed = await claimPending(db, row.id);
    if (!claimed) continue;
    if ((await processRow(db, claimed)) === "DONE") done++;
    else failed++;
  }
  for (const row of (stale ?? []) as Row[]) {
    const claimed = await reclaimProcessing(db, row.id, staleCutoff);
    if (!claimed) continue;
    if ((await processRow(db, claimed)) === "DONE") done++;
    else failed++;
  }

  const scanned = (pend?.length ?? 0) + (stale?.length ?? 0);
  return new Response(JSON.stringify({ ok: true, scanned, done, failed }), {
    headers: { "Content-Type": "application/json" },
  });
});
