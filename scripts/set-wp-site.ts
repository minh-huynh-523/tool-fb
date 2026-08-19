/**
 * Gán site WordPress đích + credential riêng cho từng page (cột facebook_page.wp_*).
 *
 *   npx tsx --env-file=.env.local scripts/set-wp-site.ts
 *
 * URL nằm ở 2 hằng SITE/PAGES bên dưới. Credential là TUỲ CHỌN và truyền qua env lúc chạy —
 * KHÔNG hard-code vào file này (nó nằm trong git):
 *
 *   WP_SITE_USER=btv WP_SITE_PASSWORD='...' npx tsx --env-file=.env.local scripts/set-wp-site.ts
 *
 * Không truyền 2 biến đó -> chỉ đổi URL, giữ nguyên credential đang lưu. Mật khẩu được mã hoá
 * AES-256-GCM bằng TOKEN_ENC_KEY trước khi ghi (lib/crypto.ts), giống access_token.
 * wp_category để null -> fallback env WP_CATEGORY.
 */
import { createWorkerSupabase } from '../lib/fb-scraper/supabase';
import { encryptToken } from '../lib/crypto';

const SITE = 'https://life.topthuysinh.com';

const PAGES = [
  '174123889119870', // Life Choices
  '101884168389181', // Right or Wrong Tales
  '104882531636535', // Story Verdicts
  '190827074108097', // The Judgment Zone
];

async function main() {
  const user = process.env.WP_SITE_USER?.trim();
  const password = process.env.WP_SITE_PASSWORD?.trim();
  if (Boolean(user) !== Boolean(password)) {
    throw new Error('WP_SITE_USER và WP_SITE_PASSWORD phải đi cùng nhau (hoặc bỏ cả hai)');
  }
  if (user && !process.env.TOKEN_ENC_KEY?.trim()) {
    throw new Error('Thiếu TOKEN_ENC_KEY — không mã hoá được mật khẩu, dừng để tránh ghi plaintext');
  }

  const patch: Record<string, string> = { wp_base_url: SITE, wp_xmlrpc_url: `${SITE}/xmlrpc.php` };
  if (user && password) {
    patch.wp_user = user;
    patch.wp_password_enc = encryptToken(password);
  }

  const db = createWorkerSupabase();
  const { data, error } = await db
    .from('facebook_page')
    .update(patch)
    .in('page_id', PAGES)
    .select('name,wp_base_url,wp_xmlrpc_url,wp_user,wp_password_enc');
  if (error) throw error;
  console.table(
    (data ?? []).map((r) => ({
      name: r.name,
      wp_base_url: r.wp_base_url,
      wp_user: r.wp_user ?? '— (env)',
      password: r.wp_password_enc ? 'đã mã hoá' : '— (env)', // không in giá trị, kể cả bản mã
    })),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
