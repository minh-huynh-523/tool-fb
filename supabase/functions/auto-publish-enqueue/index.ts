// Stage 1 của auto-publish (enqueueWpContentCandidates, xem _shared/auto-publish.ts) làm Edge
// Function ĐỘC LẬP — sync-pages/index.ts đã tự gọi hàm này trong chuỗi cron thường ngày (import
// thẳng, không qua HTTP), nhưng nút "Chạy auto-publish ngay" ở /prompts (app/api/auto-publish/run)
// cần override cửa sổ thời gian để BACKFILL 1 ngày cụ thể trong quá khứ — tách riêng thành Edge
// Function của mình để proxy Next.js gọi được với { window } tuỳ chọn mà không phải chạy nguyên
// chuỗi sync-pages (sync FB + backup ảnh + drain comment) chỉ để enqueue lại.
import { createClient } from "npm:@supabase/supabase-js@2";
import { enqueueWpContentCandidates } from "../_shared/auto-publish.ts";

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: { window?: { fromIso: string; toIso: string } } = {};
  try {
    body = await req.json();
  } catch {
    // body rỗng -> dùng cửa sổ mặc định (hôm nay từ giờ cắt).
  }

  try {
    const result = await enqueueWpContentCandidates(db, body.window);
    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
