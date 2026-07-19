/**
 * Trạng thái "page này đã copy sang Sheet chưa".
 *
 * Để RIÊNG, không nằm trong lib/queries.ts: queries.ts kéo theo lib/supabase/admin có
 * `import 'server-only'`, mà client component (nút Copy) cần dùng hàm này → import từ đó
 * là nổ build. File này thuần logic, server lẫn client đều dùng được.
 */
export type SheetState = 'chưa copy' | 'đã copy' | 'có bài mới';

/**
 * Không chỉ xét "có sheet_copied_at hay không": copy xong rồi worker cào thêm bài mới thì
 * dấu cũ thành ra nói dối. So mốc copy với giờ đăng bài mới nhất để tách 'đã copy' khỏi
 * 'có bài mới' (đã copy nhưng còn bài chưa copy).
 */
export function sheetState(copiedAt: string | null, newestPostAt: string | null): SheetState {
  if (!copiedAt) return 'chưa copy';
  if (!newestPostAt) return 'đã copy';
  return new Date(newestPostAt) > new Date(copiedAt) ? 'có bài mới' : 'đã copy';
}
