// Backfill ảnh đại diện cho các bài WP đã đăng khi luồng auto-publish còn bug serialize ảnh
// (bits truyền Uint8Array thay vì Buffer -> xmlrpc gửi <struct> thay vì <base64> -> WP không tạo
// được attachment -> bài đăng ra không có ảnh). Bug đã fix ở _shared/wordpress.ts, function này
// chỉ để vá các bài CŨ; bài mới không cần chạy.
//
// Chỉ đụng vào bài THỰC SỰ thiếu ảnh (hỏi wp.getPost trước) — nếu upload vô điều kiện thì mỗi lần
// chạy lại đẻ thêm 1 bản sao ảnh trong Media Library.
import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getWpSiteForPost, wpEditPost, wpGetThumbnailId, wpUploadFile } from "../_shared/wordpress.ts";

const UA = "fb-post-dashboard/1";

interface Result {
  postId: string;
  wpPostId?: string;
  ok: boolean;
  reason?: string;
  attachmentId?: string;
}

async function processAll(db: SupabaseClient, limit: number, dryRun: boolean): Promise<Result[]> {
  const { data, error } = await db
    .from("wp_publish_queue")
    .select("post_id, image_url")
    .eq("status", "PUBLISHED")
    .not("image_url", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const rows = (data ?? []) as { post_id: string; image_url: string | null }[];
  const results: Result[] = [];

  for (const r of rows) {
    const postId = r.post_id;
    const img = r.image_url;
    if (!img) continue;
    try {
      const { data: art } = await db
        .from("scraped_article")
        .select("wp_post_id")
        .eq("post_id", postId)
        .maybeSingle();
      const wpPostId = art?.wp_post_id ? String(art.wp_post_id) : null;
      if (!wpPostId) {
        results.push({ postId, ok: false, reason: "no_wp_post_id" });
        continue;
      }

      const site = await getWpSiteForPost(db, postId);

      // Bài đã có ảnh -> bỏ qua, KHÔNG upload lại (đây là điểm khác bản cũ).
      const existing = await wpGetThumbnailId(site, wpPostId);
      if (existing) {
        results.push({ postId, wpPostId, ok: true, reason: "already_has_thumbnail", attachmentId: existing });
        continue;
      }
      if (dryRun) {
        results.push({ postId, wpPostId, ok: true, reason: "would_fix" });
        continue;
      }

      const res = await fetch(img, { headers: { "User-Agent": UA } });
      if (!res.ok) {
        results.push({ postId, wpPostId, ok: false, reason: `fetch_failed_${res.status}` });
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      const buf = new Uint8Array(await res.arrayBuffer());
      const name = img.split("/").pop()?.split("?")[0] || "featured.jpg";
      const up = await wpUploadFile(site, { name, type: contentType, bits: buf });
      if (!up.id) {
        results.push({ postId, wpPostId, ok: false, reason: "upload_no_id" });
        continue;
      }

      const ok = await wpEditPost(site, wpPostId, { thumbnailId: up.id });
      results.push({ postId, wpPostId, ok, attachmentId: up.id, reason: ok ? "fixed" : "edit_post_false" });
    } catch (e) {
      results.push({ postId, ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

Deno.serve(async (req) => {
  // Bảo vệ nhẹ: đặt secret INTERNAL_TRIGGER_SECRET thì phải gửi kèm header x-internal-secret.
  const secret = Deno.env.get("INTERNAL_TRIGGER_SECRET");
  if (secret && req.headers.get("x-internal-secret") !== secret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const params = new URL(req.url).searchParams;
    const limit = Math.min(Number(params.get("limit") ?? 20) || 20, 100);
    const dryRun = params.get("dry") === "1";
    const results = await processAll(db, limit, dryRun);
    const fixed = results.filter((r) => r.reason === "fixed").length;
    const skipped = results.filter((r) => r.reason === "already_has_thumbnail").length;
    const failed = results.filter((r) => !r.ok).length;
    return new Response(JSON.stringify({ ok: true, scanned: results.length, fixed, skipped, failed, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
