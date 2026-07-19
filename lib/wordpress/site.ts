import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

// Cấu hình site WordPress đích của 1 page. URL lấy per-page (DB), user/password dùng chung (env).
export interface WpSite {
  xmlrpcUrl: string;
  baseUrl: string;
  category: string;
  user: string;
  password: string;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

// Resolve site WP cho 1 post: post.page_id -> facebook_page.wp_*; cột trống thì fallback về env.
// Throw message tiếng Việt (nêu tên page) để user biết đi cấu hình ở đâu.
export async function getWpSiteForPost(db: SupabaseClient, postDbId: string): Promise<WpSite> {
  const { data: post, error: postErr } = await db
    .from('post')
    .select('page_id')
    .eq('id', postDbId)
    .maybeSingle();
  if (postErr) throw new Error(postErr.message);
  if (!post) throw new Error('Không tìm thấy post');

  const { data: page, error: pageErr } = await db
    .from('facebook_page')
    .select('name, wp_xmlrpc_url, wp_base_url, wp_category')
    .eq('page_id', post.page_id)
    .maybeSingle();
  if (pageErr) throw new Error(pageErr.message);

  const label = page?.name ? `page "${page.name}"` : `page ${post.page_id}`;
  const xmlrpcUrl = (page?.wp_xmlrpc_url || process.env.WP_XMLRPC_URL || '').trim();
  const baseUrl = trimSlash((page?.wp_base_url || process.env.WP_BASE_URL || '').trim());
  const category = (page?.wp_category || process.env.WP_CATEGORY || 'Story').trim();
  const user = process.env.WP_USER ?? '';
  const password = process.env.WP_PASSWORD ?? '';

  if (!xmlrpcUrl) {
    throw new Error(`Chưa cấu hình WordPress cho ${label}: thêm XML-RPC URL ở trang Pages (hoặc đặt WP_XMLRPC_URL trong .env.local)`);
  }
  if (!user || !password) {
    throw new Error('Thiếu WP_USER / WP_PASSWORD trong .env.local');
  }

  return { xmlrpcUrl, baseUrl, category, user, password };
}
