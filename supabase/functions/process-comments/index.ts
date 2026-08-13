// Port của app/api/cron/process-comments/route.ts — an toàn lưới rút hàng đợi scheduled_comment
// chung, độc lập với sync-pages. Route Vercel cũ đã bị xoá.
//
// 2 chế độ theo body:
//   { commentId: "..." } -> rút NGAY đúng 1 row vừa được Next.js insert (thay cho
//                           after(() => drainOne(id)) chạy trong tiến trình Vercel trước đây —
//                           xem app/api/posts/[postDbId]/comments/route.ts).
//   {} / không body       -> quét toàn hàng đợi (PENDING tới hạn + PROCESSING treo), khớp
//                           route cron cũ.
import { createClient } from "npm:@supabase/supabase-js@2";
import { drainOne, processDueComments } from "../_shared/comments.ts";

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: { commentId?: string } = {};
  try {
    body = await req.json();
  } catch {
    // pg_cron gọi body rỗng — bỏ qua, coi như chế độ quét toàn hàng đợi.
  }

  if (body.commentId) {
    const status = await drainOne(db, body.commentId);
    return new Response(JSON.stringify({ ok: true, status }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = await processDueComments(db);
  return new Response(JSON.stringify({ ok: true, ...result }), {
    headers: { "Content-Type": "application/json" },
  });
});
