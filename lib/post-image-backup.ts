import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdmin } from './supabase/admin';
import { uploadPublicImage } from './supabase/storage';

// Backup ảnh FB của bài MÌNH (post.media_url) vào Supabase Storage — chạy trong cron sync-pages,
// SAU syncAllPages() (xem app/api/cron/sync-pages/route.ts). Ảnh CDN của FB hay hết hạn/chặn
// hotlink; tải 1 lần lúc sync xong là dùng lại được mãi, kể cả khi link FB gốc đã chết.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const BUCKET = 'post-media';
// cron sync-pages có maxDuration=60s và còn phải chạy processDueComments() sau — giới hạn số ảnh
// backup mỗi lượt để không đụng trần. image_backup_at NULL mới được chọn nên phần dư dồn qua lượt sau.
const BATCH_LIMIT = 15;
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface PostImageBackupResult {
  scanned: number;
  backedUp: number;
  failed: number;
}

export async function backupPostImages(
  db: SupabaseClient = createSupabaseAdmin(),
  limit: number = BATCH_LIMIT,
): Promise<PostImageBackupResult> {
  const { data, error } = await db
    .from('post')
    .select('id, page_id, fb_post_id, media_url')
    .not('media_url', 'is', null)
    .is('image_backup_at', null)
    .limit(limit);
  if (error) throw new Error(`Đọc bài cần backup ảnh lỗi: ${error.message}`);

  const due = (data ?? []) as { id: string; page_id: string; fb_post_id: string; media_url: string }[];
  if (!due.length) return { scanned: 0, backedUp: 0, failed: 0 };

  let backedUp = 0;
  let failed = 0;
  for (const p of due) {
    const patch: Record<string, unknown> = { image_backup_at: new Date().toISOString() };
    try {
      const res = await fetch(p.media_url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!res.ok || !type.startsWith('image/')) throw new Error(`link không trả về ảnh (HTTP ${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = EXT_BY_MIME[type] ?? 'jpg';
      const path = `${p.page_id}/${p.fb_post_id}.${ext}`;
      const url = await uploadPublicImage(db, { bucket: BUCKET, path, buffer: buf, contentType: type });
      patch.image_backup_url = url;
      patch.image_backup_error = null;
      backedUp++;
    } catch (e) {
      patch.image_backup_error = e instanceof Error ? e.message : String(e);
      failed++;
    }
    const { error: upErr } = await db.from('post').update(patch).eq('id', p.id);
    if (upErr) console.error(`  ↳ KHÔNG ghi được backup ảnh cho bài ${p.id}: ${upErr.message}`);
  }
  return { scanned: due.length, backedUp, failed };
}
