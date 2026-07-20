import { createWorkerSupabase } from '../lib/fb-scraper/supabase';

async function main() {
  const db = createWorkerSupabase();
  const { data, error } = await db
    .from('facebook_page')
    .select('page_id,name,wp_base_url,wp_xmlrpc_url,wp_category')
    .order('name');
  if (error) throw error;
  console.table(
    (data ?? []).map((r) => ({
      name: r.name,
      wp_base_url: r.wp_base_url ?? '— (env)',
      wp_xmlrpc_url: r.wp_xmlrpc_url ?? '— (env)',
      wp_category: r.wp_category ?? '— (env)',
    })),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
