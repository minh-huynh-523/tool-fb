import 'server-only';

// Gọi 1 Supabase Edge Function server-to-server bằng service_role key. Vercel giờ chỉ còn là UI —
// mọi route "xử lý" (gọi Facebook Graph/WordPress/Gemini/gửi comment) chỉ còn check session rồi
// proxy vào đây, logic thật nằm ở supabase/functions/** (xem CLAUDE.md).
export async function callEdgeFunction<T = unknown>(
  name: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; data: T }> {
  const raw = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const base = raw.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !serviceKey) {
    throw new Error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY');
  }
  const res = await fetch(`${base}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, data };
}
