/**
 * Gán site WordPress đích cho từng page (cột facebook_page.wp_*).
 *
 *   npx tsx --env-file=.env.local scripts/set-wp-site.ts
 *
 * Chỉ URL nằm ở DB — WP_USER/WP_PASSWORD vẫn dùng chung từ .env.local (xem lib/wordpress/site.ts).
 * wp_category để null → fallback env WP_CATEGORY.
 */
import { createWorkerSupabase } from '../lib/fb-scraper/supabase';

const SITE = 'https://story.investvinhphuc.vn';

const PAGES = ['350767141731232', '107215740962199', '307703289635630']; // Delta D, Amazing Videos, News Makers

async function main() {
  const db = createWorkerSupabase();
  const { data, error } = await db
    .from('facebook_page')
    .update({ wp_base_url: SITE, wp_xmlrpc_url: `${SITE}/xmlrpc.php` })
    .in('page_id', PAGES)
    .select('name,wp_base_url,wp_xmlrpc_url');
  if (error) throw error;
  console.table(data);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
