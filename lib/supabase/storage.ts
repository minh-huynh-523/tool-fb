import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

// Upload 1 ảnh vào bucket PUBLIC (xem migration 0023) rồi trả về URL public — dùng để backup ảnh
// FB (link CDN hay hết hạn/bị chặn hotlink) thành bản bền do MÌNH kiểm soát.
export async function uploadPublicImage(
  db: SupabaseClient,
  input: { bucket: string; path: string; buffer: Buffer; contentType: string },
): Promise<string> {
  const { bucket, path, buffer, contentType } = input;
  const { error } = await db.storage.from(bucket).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Upload Supabase Storage lỗi: ${error.message}`);
  const { data } = db.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('Supabase Storage không trả về public URL');
  return data.publicUrl;
}
