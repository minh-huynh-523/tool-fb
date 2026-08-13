// Port của lib/supabase/storage.ts cho Deno — chỉ đổi Buffer -> Uint8Array (Deno fetch trả
// ArrayBuffer trực tiếp, không cần Buffer polyfill).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function uploadPublicImage(
  db: SupabaseClient,
  input: { bucket: string; path: string; buffer: Uint8Array; contentType: string },
): Promise<string> {
  const { bucket, path, buffer, contentType } = input;
  const { error } = await db.storage.from(bucket).upload(path, buffer, { contentType, upsert: true });
  if (error) throw new Error(`Upload Supabase Storage lỗi: ${error.message}`);
  const { data } = db.storage.from(bucket).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error("Supabase Storage không trả về public URL");
  return data.publicUrl;
}
