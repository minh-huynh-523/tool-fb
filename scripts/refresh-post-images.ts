// Vá các bài WP đang dùng ảnh đại diện QUÁ NHỎ (thumbnail reel ~160px chộp lúc bài chưa đăng).
// Ảnh dưới 200px bị Rank Math loại khỏi og:image -> link "Full story" trong comment Facebook không
// có thumbnail. Nguyên nhân gốc đã sửa ở supabase/functions/_shared/{sync,post-image-backup}.ts;
// script này chỉ dọn dữ liệu cũ.
//
// Chạy:  npm run wp:refresh-images -- --dry    (chỉ đo và liệt kê)
//        npm run wp:refresh-images             (tải ảnh lớn -> Storage + ảnh đại diện WP)
//
// Ảnh lớn lấy từ post.media_url (link CDN của FB, chỉ sống vài ngày) nên hãy chạy sync-pages
// trước để media_url còn tươi; bài nào link đã chết thì script báo FAIL và bỏ qua, không ghi gì.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Agent, fetch as undiciFetch } from 'undici';
import xmlrpc from 'xmlrpc';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MIN_WIDTH = 200; // ngưỡng og:image của Facebook (và của Rank Math)
const BUCKET = 'post-media';

interface WpSite {
  xmlrpcUrl: string;
  user: string;
  password: string;
}

function call<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const client = url.startsWith('https') ? xmlrpc.createSecureClient({ url }) : xmlrpc.createClient({ url });
  return new Promise<T>((resolve, reject) =>
    client.methodCall(method, params, (err: unknown, value: unknown) => {
      if (err) {
        const e = err as { faultString?: string; message?: string };
        reject(new Error(e.faultString ?? e.message ?? 'Lỗi XML-RPC'));
      } else resolve(value as T);
    }),
  );
}

// Đọc kích thước ảnh từ header (JPEG SOFn / PNG IHDR / WebP VP8*) — đủ cho 3 định dạng FB trả về,
// khỏi kéo thêm dependency chỉ để biết chiều rộng.
function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fmt === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // SOF0..SOF15 trừ DHT(c4)/JPG(c8)/DAC(cc) — mọi biến thể đều có height/width ở cùng offset.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// IPv4 + connect timeout rộng tay: từ máy này, địa chỉ IPv6 của scontent-*.fbcdn.net treo hẳn
// (Happy Eyeballs của undici vẫn timeout ở cả 10s lẫn 30s) trong khi IPv4 trả ảnh ngay. Không ép
// family=4 thì vài bài cứ "fetch failed" mọi lượt chạy, mà curl thì tải được — rất khó đoán.
const imageAgent = new Agent({ connect: { family: 4, timeout: 30_000 } });

// Thử lại vài lần cho các lỗi mạng chập chờn còn lại.
async function fetchImage(url: string, attempts = 3): Promise<{ buf: Buffer; type: string }> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await undiciFetch(url, { headers: { 'User-Agent': UA }, dispatcher: imageAgent });
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!type.startsWith('image/')) throw new Error(`không phải ảnh (${type || 'không rõ'})`);
      return { buf: Buffer.from(await res.arrayBuffer()), type };
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw last;
}

async function getWpSiteForPost(db: SupabaseClient, pageId: string): Promise<WpSite> {
  const { data: page } = await db.from('facebook_page').select('wp_xmlrpc_url').eq('page_id', pageId).maybeSingle();
  const xmlrpcUrl = (page?.wp_xmlrpc_url || process.env.WP_XMLRPC_URL || '').trim();
  const user = process.env.WP_USER ?? '';
  const password = process.env.WP_PASSWORD ?? '';
  if (!xmlrpcUrl) throw new Error('Chưa cấu hình XML-RPC URL cho page này');
  if (!user || !password) throw new Error('Thiếu WP_USER / WP_PASSWORD');
  return { xmlrpcUrl, user, password };
}

interface Row {
  id: string;
  page_id: string;
  fb_post_id: string;
  media_url: string | null;
  image_backup_url: string;
  scraped_article: { wp_post_id: string | null; wp_status: string | null } | null;
}

// --pending: bài ĐÃ đăng FB, CHƯA lên WordPress, nhưng ảnh backup còn là bản nhỏ chộp lúc chúng
// còn là reel lên lịch. Xoá mốc backup để cron tải lại từ media_url hiện tại (bản 405x720) TRƯỚC
// khi auto-publish rút chúng ra — không thì cả loạt lại ra bài WordPress thiếu og:image.
// Chỉ xoá mốc, KHÔNG xoá image_backup_url: nếu tải lại hỏng thì bài vẫn còn ảnh cũ để dùng.
async function resetPendingBackups(db: SupabaseClient, dryRun: boolean): Promise<void> {
  const { data, error } = await db
    .from('post')
    .select('id, image_backup_url, image_backup_at, scraped_article!left(post_id)')
    .eq('is_published', true)
    .not('image_backup_url', 'is', null)
    .not('image_backup_at', 'is', null)
    .order('fb_created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(`Đọc post lỗi: ${error.message}`);

  const pending = ((data ?? []) as unknown as {
    id: string;
    image_backup_url: string;
    scraped_article: unknown | null;
  }[]).filter((r) => !r.scraped_article);
  console.log(`${pending.length} bài đã đăng FB nhưng chưa lên WordPress\n`);

  const small: string[] = [];
  for (const r of pending) {
    try {
      const img = await fetchImage(r.image_backup_url);
      const size = imageSize(img.buf);
      if (!size || size.width < MIN_WIDTH) small.push(r.id);
    } catch (e) {
      console.log(`  ${r.id.slice(0, 8)} — không đo được ảnh: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`${small.length} bài đang giữ ảnh dưới ${MIN_WIDTH}px`);
  if (!small.length || dryRun) {
    if (dryRun && small.length) console.log('DRY RUN — chưa xoá mốc backup nào');
    return;
  }
  const { error: upErr } = await db.from('post').update({ image_backup_at: null }).in('id', small);
  if (upErr) throw new Error(`Xoá mốc backup lỗi: ${upErr.message}`);
  console.log(`Đã xoá mốc backup cho ${small.length} bài — cron sẽ tải lại ảnh lớn ở lượt tới.`);
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const pendingMode = process.argv.includes('--pending');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (dùng --env-file=.env.local)');
    process.exit(1);
  }
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  if (pendingMode) {
    await resetPendingBackups(db, dryRun);
    return;
  }

  const { data, error } = await db
    .from('post')
    .select('id, page_id, fb_post_id, media_url, image_backup_url, scraped_article!inner(wp_post_id, wp_status)')
    .not('image_backup_url', 'is', null)
    .order('fb_created_at', { ascending: true });
  if (error) {
    console.error('Đọc post lỗi:', error.message);
    process.exit(1);
  }
  const rows = ((data ?? []) as unknown as Row[]).filter(
    (r) => r.scraped_article?.wp_post_id && r.scraped_article.wp_status !== 'trash',
  );
  console.log(`${rows.length} bài WP có ảnh backup${dryRun ? ' — DRY RUN' : ''}\n`);

  let okAlready = 0;
  let fixed = 0;
  let failed = 0;

  for (const r of rows) {
    const wpPostId = String(r.scraped_article!.wp_post_id);
    const tag = `wp=${wpPostId} post=${r.id.slice(0, 8)}`;
    try {
      const current = await fetchImage(r.image_backup_url);
      const curSize = imageSize(current.buf);
      if (curSize && curSize.width >= MIN_WIDTH) {
        console.log(`${tag} — OK (${curSize.width}x${curSize.height})`);
        okAlready++;
        continue;
      }

      if (!r.media_url) {
        console.log(`${tag} — SKIP: ảnh ${curSize?.width ?? '?'}px nhưng post không còn media_url`);
        failed++;
        continue;
      }
      const fresh = await fetchImage(r.media_url);
      const newSize = imageSize(fresh.buf);
      if (!newSize || newSize.width < MIN_WIDTH) {
        console.log(`${tag} — SKIP: FB cũng chỉ có ${newSize?.width ?? '?'}px`);
        failed++;
        continue;
      }
      if (dryRun) {
        console.log(`${tag} — SẼ VÁ ${curSize?.width ?? '?'}px -> ${newSize.width}x${newSize.height}`);
        fixed++;
        continue;
      }

      // Ghi đè đúng path cũ để image_backup_url không đổi (nhiều nơi đã lưu link này).
      const path = r.image_backup_url.split(`/${BUCKET}/`)[1];
      if (!path) throw new Error(`không tách được path Storage từ ${r.image_backup_url}`);
      const { error: upErr } = await db.storage
        .from(BUCKET)
        .upload(path, fresh.buf, { contentType: fresh.type, upsert: true });
      if (upErr) throw new Error(`Storage: ${upErr.message}`);
      await db.from('post').update({ image_backup_at: new Date().toISOString(), image_backup_error: null }).eq('id', r.id);

      // Tên mới (-hd) để không ghi đè attachment nhỏ đang gắn ở bài khác.
      const site = await getWpSiteForPost(db, r.page_id);
      const up = await call<{ id?: number | string; attachment_id?: number | string }>(site.xmlrpcUrl, 'wp.uploadFile', [
        0,
        site.user,
        site.password,
        { name: `${r.fb_post_id}-hd.jpg`, type: fresh.type, bits: fresh.buf, overwrite: true },
      ]);
      const attachmentId = up.attachment_id ?? up.id;
      if (attachmentId == null) throw new Error('upload WP không trả attachment id');
      const ok = await call<boolean>(site.xmlrpcUrl, 'wp.editPost', [
        0,
        site.user,
        site.password,
        parseInt(wpPostId, 10),
        { post_thumbnail: Number(attachmentId) },
      ]);
      if (!ok) throw new Error('wp.editPost trả false');
      console.log(`${tag} — ĐÃ VÁ ${curSize?.width ?? '?'}px -> ${newSize.width}x${newSize.height} (thumb ${attachmentId})`);
      fixed++;
    } catch (e) {
      // fetch của Node giấu lý do thật trong `cause` (ECONNRESET, TLS, DNS...) — in kèm, không thì
      // mọi sự cố mạng đều hiện đúng một dòng "fetch failed" vô dụng.
      const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : '';
      console.log(`${tag} — LỖI: ${e instanceof Error ? e.message : String(e)}${cause}`);
      failed++;
    }
  }

  console.log(`\n--- Tổng kết ---\n${dryRun ? 'sẽ vá' : 'đã vá'}=${fixed}  ảnh đã đủ lớn=${okAlready}  lỗi/bỏ qua=${failed}`);
}

main().catch((e) => {
  console.error('Lỗi:', e);
  process.exit(2);
});
