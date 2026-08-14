// Port của app/api/cron/sync-pages/route.ts CỘNG app/api/pages/sync-all + app/api/pages/[pageId]/sync
// gộp vào 1 Edge Function — 3 route Vercel đó giờ chỉ còn là proxy mỏng (check session -> gọi HTTP
// vào đây -> trả nguyên response), không tự chạy lib/sync.ts nữa (xem CLAUDE.md/plan: Vercel chỉ
// còn là UI).
//
// 2 chế độ theo body:
//   { pageId: "..." }  -> CHỈ sync 1 page (khớp hành vi nút "Sync" 1 page cũ) — KHÔNG chạy
//                         backup ảnh/enqueue auto-publish/drain comment (route cũ cũng không).
//   {} / không body    -> chuỗi đầy đủ: syncAllPages -> backupPostImages (best-effort) ->
//                         enqueueWpContentCandidates (best-effort) -> processDueComments — khớp
//                         cron sync-pages VÀ nút "Sync all" cũ (route cũ chỉ cần results/total,
//                         nhận thêm field không dùng thì bỏ qua).
//
// Lên lịch bằng pg_cron trong chính Supabase (xem migration 0026) — route Vercel cũ
// app/api/cron/sync-pages đã bị xoá.
import { createClient } from "npm:@supabase/supabase-js@2";
import { syncPage, syncAllPages } from "../_shared/sync.ts";
import { backupPostImages } from "../_shared/post-image-backup.ts";
import { enqueueWpContentCandidates } from "../_shared/auto-publish.ts";
import { processDueComments } from "../_shared/comments.ts";

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: { pageId?: string } = {};
  try {
    body = await req.json();
  } catch {
    // pg_cron gọi body rỗng ('{}') — bỏ qua, coi như chế độ đầy đủ.
  }

  if (body.pageId) {
    try {
      const result = await syncPage(db, body.pageId);
      return new Response(JSON.stringify({ result }), {
        status: result.ok ? 200 : 400,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const results = await syncAllPages(db, { limit: 25 });
  const total = results.reduce((n, r) => n + r.count, 0);
  const imageBackup = await backupPostImages(db).catch((e) => {
    console.error("[image-backup] lỗi:", e instanceof Error ? e.message : String(e));
    return null;
  });
  const autoPublishEnqueued = await enqueueWpContentCandidates(db).catch((e) => {
    console.error("[auto-publish] enqueue lỗi:", e instanceof Error ? e.message : String(e));
    return null;
  });
  const comments = await processDueComments(db);

  return new Response(JSON.stringify({ ok: true, results, total, imageBackup, autoPublishEnqueued, comments }), {
    headers: { "Content-Type": "application/json" },
  });
});
