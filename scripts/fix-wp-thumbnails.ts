// Backfill ảnh đại diện cho bài WP đã đăng khi luồng auto-publish còn bug serialize ảnh
// (Edge Function truyền bits là Uint8Array -> xmlrpc gửi <struct> thay vì <base64> -> WP không tạo
// được attachment -> bài ra không ảnh). Bug đã fix ở supabase/functions/_shared/wordpress.ts;
// script này chỉ vá bài CŨ. Bản chạy trên Supabase: supabase/functions/fix-wp-thumbnails.
//
// Chạy:  npm run wp:fix-thumbnails -- --dry       (chỉ liệt kê, không đụng WP)
//        npm run wp:fix-thumbnails                (upload + set ảnh đại diện)
//        npm run wp:fix-thumbnails -- --all       (quét MỌI bài WP trong scraped_article, kể cả
//                                                  bài đăng tay trong app, không chỉ hàng đợi auto)
//
// Tự viết lại phần gọi XML-RPC thay vì import lib/wordpress/* vì lib đó gắn 'server-only'
// (chỉ chạy trong Next.js), giống các script khác trong thư mục này.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import xmlrpc from 'xmlrpc';

const UA = 'fb-post-dashboard/1';

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

async function getWpSiteForPost(db: SupabaseClient, postDbId: string): Promise<WpSite> {
  const { data: post, error } = await db.from('post').select('page_id').eq('id', postDbId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!post) throw new Error('Không tìm thấy post');
  const { data: page } = await db
    .from('facebook_page')
    .select('wp_xmlrpc_url')
    .eq('page_id', post.page_id)
    .maybeSingle();
  const xmlrpcUrl = (page?.wp_xmlrpc_url || process.env.WP_XMLRPC_URL || '').trim();
  const user = process.env.WP_USER ?? '';
  const password = process.env.WP_PASSWORD ?? '';
  if (!xmlrpcUrl) throw new Error('Chưa cấu hình XML-RPC URL cho page này');
  if (!user || !password) throw new Error('Thiếu WP_USER / WP_PASSWORD');
  return { xmlrpcUrl, user, password };
}

// null = bài chưa có ảnh đại diện (WP trả struct rỗng). Ném lỗi nếu bài không tồn tại.
async function wpGetThumbnailId(site: WpSite, postId: string): Promise<string | null> {
  const res = await call<{ post_thumbnail?: { attachment_id?: number | string; id?: number | string } }>(
    site.xmlrpcUrl,
    'wp.getPost',
    [0, site.user, site.password, parseInt(postId, 10), ['post_thumbnail']],
  );
  const t = res.post_thumbnail;
  if (!t || Object.keys(t).length === 0) return null;
  const id = t.attachment_id ?? t.id;
  return id != null ? String(id) : null;
}

interface Target {
  postId: string;
  wpPostId: string;
  imageUrl: string;
  when: string;
}

// Mặc định: chỉ bài do cron auto-publish đăng (ảnh nguồn đã chốt sẵn trong hàng đợi).
async function loadQueueRows(db: SupabaseClient): Promise<Target[]> {
  const { data, error } = await db
    .from('wp_publish_queue')
    .select('post_id, image_url, created_at, scraped_article:post_id(wp_post_id)')
    .eq('status', 'PUBLISHED')
    .not('image_url', 'is', null)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Đọc wp_publish_queue lỗi: ${error.message}`);
  return ((data ?? []) as unknown as {
    post_id: string;
    image_url: string;
    created_at: string;
    scraped_article: { wp_post_id: string | null } | null;
  }[])
    .filter((r) => r.scraped_article?.wp_post_id)
    .map((r) => ({
      postId: r.post_id,
      wpPostId: String(r.scraped_article!.wp_post_id),
      imageUrl: r.image_url,
      when: r.created_at,
    }));
}

// --all: MỌI bài WP đã tạo (kể cả đăng tay trong app), ảnh nguồn lấy từ post.image_backup_url —
// bản backup trong Supabase Storage, KHÔNG dùng post.media_url (CDN của FB hay hết hạn/chặn hotlink).
// Bỏ bài đã trash và bài không có ảnh backup (không có gì để gắn).
async function loadAllArticles(db: SupabaseClient): Promise<Target[]> {
  const { data, error } = await db
    .from('scraped_article')
    .select('post_id, wp_post_id, wp_status, created_at, post:post_id(image_backup_url)')
    .not('wp_post_id', 'is', null)
    .neq('wp_status', 'trash')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Đọc scraped_article lỗi: ${error.message}`);
  return ((data ?? []) as unknown as {
    post_id: string;
    wp_post_id: string;
    created_at: string;
    post: { image_backup_url: string | null } | null;
  }[])
    .filter((r) => r.post?.image_backup_url)
    .map((r) => ({
      postId: r.post_id,
      wpPostId: String(r.wp_post_id),
      imageUrl: r.post!.image_backup_url!,
      when: r.created_at,
    }));
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const scanAll = process.argv.includes('--all');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (dùng --env-file=.env.local)');
    process.exit(1);
  }
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const rows = scanAll ? await loadAllArticles(db) : await loadQueueRows(db);
  console.log(
    `${rows.length} bài WP có ảnh nguồn (${scanAll ? 'MỌI bài trong scraped_article' : 'hàng đợi auto-publish'})` +
      `${dryRun ? ' — DRY RUN' : ''}\n`,
  );

  let fixed = 0;
  let alreadyOk = 0;
  let failed = 0;

  for (const row of rows) {
    const tag = `${row.when.slice(0, 16)} post=${row.postId.slice(0, 8)}`;
    const wpPostId = row.wpPostId;
    try {
      const site = await getWpSiteForPost(db, row.postId);
      const existing = await wpGetThumbnailId(site, wpPostId);
      if (existing) {
        console.log(`${tag} wp=${wpPostId} — OK sẵn (thumb ${existing})`);
        alreadyOk++;
        continue;
      }
      if (dryRun) {
        console.log(`${tag} wp=${wpPostId} — THIẾU ẢNH, sẽ vá`);
        fixed++;
        continue;
      }

      const res = await fetch(row.imageUrl, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        console.log(`${tag} wp=${wpPostId} — FAIL tải ảnh: HTTP ${res.status}`);
        failed++;
        continue;
      }
      const type = res.headers.get('content-type') ?? 'image/jpeg';
      const bits = Buffer.from(await res.arrayBuffer());
      const name = row.imageUrl.split('/').pop()?.split('?')[0] || 'featured.jpg';
      const up = await call<{ id?: number | string; attachment_id?: number | string }>(
        site.xmlrpcUrl,
        'wp.uploadFile',
        [0, site.user, site.password, { name, type, bits, overwrite: true }],
      );
      const attachmentId = up.attachment_id ?? up.id;
      if (attachmentId == null) {
        console.log(`${tag} wp=${wpPostId} — FAIL: upload không trả attachment id`);
        failed++;
        continue;
      }
      const ok = await call<boolean>(site.xmlrpcUrl, 'wp.editPost', [
        0,
        site.user,
        site.password,
        parseInt(wpPostId, 10),
        { post_thumbnail: Number(attachmentId) },
      ]);
      if (ok) {
        console.log(`${tag} wp=${wpPostId} — ĐÃ VÁ (thumb ${attachmentId})`);
        fixed++;
      } else {
        console.log(`${tag} wp=${wpPostId} — FAIL: wp.editPost trả false`);
        failed++;
      }
    } catch (e) {
      console.log(`${tag} — LỖI: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  console.log(`\n--- Tổng kết ---\n${dryRun ? 'sẽ vá' : 'đã vá'}=${fixed}  có sẵn ảnh=${alreadyOk}  lỗi=${failed}`);
}

main().catch((e) => {
  console.error('Lỗi:', e);
  process.exit(2);
});
