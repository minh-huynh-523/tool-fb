import 'server-only';
import { createClient } from '@supabase/supabase-js';

// Client dùng service_role — CHỈ server-side (API routes). Bypass RLS.
// Không bao giờ import file này vào code chạy ở client.
export function createSupabaseAdmin() {
  // Chấp nhận cả SUPABASE_URL (khuyến nghị) lẫn NEXT_PUBLIC_SUPABASE_URL; tự cắt đuôi /rest/v1.
  const raw = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const url = raw.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
