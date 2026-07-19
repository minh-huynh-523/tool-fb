/**
 * Supabase client cho WORKER (chạy bằng tsx/Node ở laptop, KHÔNG phải Next.js).
 * KHÁC lib/supabase/admin.ts: file này KHÔNG dùng `import 'server-only'` (server-only throw
 * ngoài môi trường Next), và cắm `ws` làm WebSocket transport vì Node < 22 chưa có WebSocket
 * global → supabase-js crash khi khởi tạo RealtimeClient. Ta không dùng realtime, chỉ PostgREST.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';

export function createWorkerSupabase(): SupabaseClient {
  const raw = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const url = raw.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY trong .env.local (worker)');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws as never }, // Node 20 không có WebSocket global
  });
}
