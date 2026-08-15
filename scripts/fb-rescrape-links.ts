// Bảo Facebook nạp lại cache Open Graph của các permalink WordPress đã đăng vào comment.
// FB chỉ crawl 1 lần rồi cache; những bài từng thiếu og:image (ảnh đại diện dưới 200px — xem
// scripts/refresh-post-images.ts) sẽ mãi hiện comment không thumbnail cho tới khi được scrape lại.
//
// Chạy:  npm run fb:rescrape -- --dry     (chỉ liệt kê link sẽ scrape)
//        npm run fb:rescrape              (gọi Graph API scrape=true cho từng link)
//
// LƯU Ý: scrape chỉ làm mới cache của LINK. Comment đã đăng từ trước thường giữ nguyên thẻ preview
// đã render lúc đăng — cái chắc chắn hưởng lợi là các comment đăng sau khi scrape xong.
import { createClient } from '@supabase/supabase-js';
import { decryptToken } from '../lib/crypto';

const GRAPH = `https://graph.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || 'v21.0'}`;

interface Row {
  wp_permalink: string;
  post: { page_id: string } | null;
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (dùng --env-file=.env.local)');
    process.exit(1);
  }
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data, error } = await db
    .from('scraped_article')
    .select('wp_permalink, post:post_id(page_id)')
    .not('wp_permalink', 'is', null)
    .neq('wp_status', 'trash')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('Đọc scraped_article lỗi:', error.message);
    process.exit(1);
  }
  const rows = ((data ?? []) as unknown as Row[]).filter((r) => r.post?.page_id);

  const { data: pages } = await db.from('facebook_page').select('page_id, access_token');
  const tokens = new Map(
    ((pages ?? []) as { page_id: string; access_token: string }[]).map((p) => [p.page_id, p.access_token]),
  );

  console.log(`${rows.length} permalink${dryRun ? ' — DRY RUN' : ''}\n`);
  let withImage = 0;
  let noImage = 0;
  let failed = 0;

  for (const r of rows) {
    const url = r.wp_permalink;
    const short = url.replace(/^https?:\/\//, '').slice(0, 60);
    if (dryRun) {
      console.log(`SẼ SCRAPE ${short}`);
      continue;
    }
    const stored = tokens.get(r.post!.page_id);
    if (!stored) {
      console.log(`${short} — SKIP: page ${r.post!.page_id} chưa có token`);
      failed++;
      continue;
    }
    try {
      const token = decryptToken(stored);
      const res = await fetch(`${GRAPH}/?id=${encodeURIComponent(url)}&scrape=true&access_token=${token}`, {
        method: 'POST',
      });
      const body = (await res.json()) as { image?: { url: string }[]; error?: { message?: string } };
      if (!res.ok || body.error) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      const img = body.image?.[0]?.url ?? null;
      if (img) {
        console.log(`${short} — OK, og:image = ${img.split('/').pop()}`);
        withImage++;
      } else {
        console.log(`${short} — CẢNH BÁO: FB vẫn không thấy ảnh nào`);
        noImage++;
      }
    } catch (e) {
      console.log(`${short} — LỖI: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  if (!dryRun) console.log(`\n--- Tổng kết ---\ncó ảnh=${withImage}  không ảnh=${noImage}  lỗi=${failed}`);
}

main().catch((e) => {
  console.error('Lỗi:', e);
  process.exit(2);
});
