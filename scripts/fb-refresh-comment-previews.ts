// Vẽ lại thẻ preview của các comment "Full story: <link WP>" đã đăng.
//
// Facebook chốt ảnh preview NGAY LÚC comment được đăng và không bao giờ tự cập nhật — kể cả sau
// khi trang WP đã có og:image đúng và cache link đã được scrape lại (scripts/fb-rescrape-links.ts).
// Những comment đăng lúc bài còn thiếu og:image vì thế mãi hiện logo của site.
// Cách chữa: POST lại chính message cũ lên comment -> FB render lại attachment từ cache link hiện
// tại. Comment giữ nguyên id, lượt thích và trả lời; đổi lại Facebook gắn nhãn "Đã chỉnh sửa".
//
// Chạy:  npm run fb:refresh-comments -- --dry    (chỉ so sánh, không sửa gì)
//        npm run fb:refresh-comments             (sửa những comment đang hiện sai ảnh)
import { createClient } from '@supabase/supabase-js';
import { Agent, fetch as undiciFetch } from 'undici';
import { decryptToken } from '../lib/crypto';

const GRAPH = `https://graph.facebook.com/${process.env.FACEBOOK_GRAPH_VERSION || 'v21.0'}`;
// Ép IPv4 vì route IPv6 tới Facebook trên máy này treo tới hết timeout (xem refresh-post-images.ts).
const agent = new Agent({ connect: { family: 4, timeout: 30_000 } });
const UA = 'facebookexternalhit/1.1';

interface Row {
  id: string;
  fb_comment_id: string;
  message: string;
  page_id: string;
}

// FB bọc ảnh preview qua external.*.fbcdn.net với link gốc nằm trong query `url=`.
function realImageUrl(src: string | undefined): string | null {
  if (!src) return null;
  const m = src.match(/[?&]url=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : src;
}

// FB hay lấy một size do WP sinh ra (…-405x247.jpg) thay vì file gốc (….jpg) — cùng một ảnh.
// Bỏ hậu tố kích thước trước khi so, không thì mọi comment đúng đều bị coi là sai.
function imageKey(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/-\d+x\d+(\.[a-z]+)$/i, '$1');
}

async function ogImage(pageUrl: string): Promise<string | null> {
  const res = await undiciFetch(pageUrl, { headers: { 'User-Agent': UA }, dispatcher: agent });
  if (!res.ok) throw new Error(`trang WP trả HTTP ${res.status}`);
  const html = await res.text();
  return html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;
}

function isRateLimited(msg: string): boolean {
  return /#4\)|request limit reached|rate limit/i.test(msg);
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

  // --recent-hours=N: chỉ đụng comment vừa gửi. Facebook chỉ chịu vẽ lại thẻ preview của comment
  // còn mới; comment cũ thì Graph nhận lệnh sửa mà không đổi gì, chỉ tổ dính nhãn "Đã chỉnh sửa".
  const hoursArg = process.argv.find((a) => a.startsWith('--recent-hours='));
  const hours = hoursArg ? Number(hoursArg.split('=')[1]) : null;
  let query = db
    .from('scheduled_comment')
    .select('id, fb_comment_id, message, page_id')
    .eq('status', 'SENT')
    .not('fb_comment_id', 'is', null)
    .like('message', 'Full story%');
  if (hours && hours > 0) {
    query = query.gte('sent_at', new Date(Date.now() - hours * 3600_000).toISOString());
  }
  const { data, error } = await query.order('sent_at', { ascending: true });
  if (error) {
    console.error('Đọc scheduled_comment lỗi:', error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as Row[];

  const { data: pages } = await db.from('facebook_page').select('page_id, access_token');
  const tokens = new Map(
    ((pages ?? []) as { page_id: string; access_token: string }[]).map((p) => [p.page_id, decryptToken(p.access_token)]),
  );

  console.log(`${rows.length} comment "Full story"${dryRun ? ' — DRY RUN' : ''}\n`);
  let okAlready = 0;
  let refreshed = 0;
  let failed = 0;

  for (const row of rows) {
    const link = row.message.match(/https?:\/\/\S+/)?.[0]?.replace(/[).,]+$/, '');
    const tag = link ? link.replace(/^https?:\/\//, '').slice(0, 48) : `comment ${row.fb_comment_id}`;
    try {
      const token = tokens.get(row.page_id);
      if (!token) throw new Error(`page ${row.page_id} chưa có token`);
      if (!link) throw new Error('message không chứa link');

      const want = await ogImage(link);
      if (!want) throw new Error('trang WP không có og:image');

      const cur = await undiciFetch(`${GRAPH}/${row.fb_comment_id}?fields=attachment&access_token=${token}`, {
        dispatcher: agent,
      });
      const curBody = (await cur.json()) as {
        attachment?: { media?: { image?: { src?: string } } };
        error?: { message?: string };
      };
      if (curBody.error) throw new Error(curBody.error.message ?? 'Graph lỗi');
      const have = realImageUrl(curBody.attachment?.media?.image?.src);
      if (imageKey(have) === imageKey(want)) {
        console.log(`${tag} — OK sẵn`);
        okAlready++;
        continue;
      }
      if (dryRun) {
        console.log(
          `${tag} — SẼ SỬA (đang: ${have?.split('/').pop() ?? 'không ảnh'} | cần: ${want.split('/').pop()})`,
        );
        refreshed++;
        continue;
      }

      // Scrape link TRƯỚC khi sửa comment. FB dựng lại attachment từ cache của link, nên sửa lúc
      // cache còn cũ/trống thì comment ra ảnh sai — hoặc mất hẳn ảnh, tệ hơn trước khi sửa.
      const sc = await undiciFetch(`${GRAPH}/?id=${encodeURIComponent(link)}&scrape=true&access_token=${token}`, {
        method: 'POST',
        dispatcher: agent,
      });
      const scBody = (await sc.json()) as { image?: { url: string }[]; error?: { message?: string } };
      if (scBody.error) throw new Error(scBody.error.message ?? 'Graph lỗi khi scrape link');
      if (!scBody.image?.length) throw new Error('FB scrape link xong vẫn không thấy ảnh — bỏ qua, KHÔNG sửa comment');

      const up = await undiciFetch(`${GRAPH}/${row.fb_comment_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: row.message, access_token: token }),
        dispatcher: agent,
      });
      const upBody = (await up.json()) as { success?: boolean; error?: { message?: string } };
      if (upBody.error) throw new Error(upBody.error.message ?? 'Graph lỗi');

      // ĐỌC LẠI attachment thay vì tin `success: true`. Graph trả success cho lệnh sửa message dù
      // KHÔNG vẽ lại thẻ preview — báo "đã sửa" theo ảnh mong muốn là báo láo, comment vẫn hiện
      // logo cũ mà lại mang thêm nhãn "Đã chỉnh sửa".
      await new Promise((r) => setTimeout(r, 3000));
      const after = await undiciFetch(`${GRAPH}/${row.fb_comment_id}?fields=attachment&access_token=${token}`, {
        dispatcher: agent,
      });
      const afterBody = (await after.json()) as { attachment?: { media?: { image?: { src?: string } } } };
      const now = realImageUrl(afterBody.attachment?.media?.image?.src);
      if (imageKey(now) === imageKey(want)) {
        console.log(`${tag} — ĐÃ SỬA -> ${now!.split('/').pop()}`);
        refreshed++;
      } else {
        console.log(`${tag} — KHÔNG ĂN: FB vẫn giữ ${now?.split('/').pop() ?? 'không ảnh'} (comment đã bị đánh dấu sửa)`);
        failed++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`${tag} — LỖI: ${msg}`);
      failed++;
      // Hết hạn mức Graph thì dừng: chạy tiếp chỉ đốt thêm quota dùng chung với cron.
      if (isRateLimited(msg)) {
        console.log('\nDỪNG: Facebook báo hết hạn mức request cho app. Chờ khoảng 1 giờ rồi chạy lại.');
        break;
      }
    }
  }

  console.log(`\n--- Tổng kết ---\n${dryRun ? 'sẽ sửa' : 'đã sửa'}=${refreshed}  đúng sẵn=${okAlready}  lỗi=${failed}`);
}

main().catch((e) => {
  console.error('Lỗi:', e);
  process.exit(2);
});
