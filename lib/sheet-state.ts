/**
 * Trạng thái "page này đã copy sang Sheet chưa".
 *
 * Để RIÊNG, không nằm trong lib/queries.ts: queries.ts kéo theo lib/supabase/admin có
 * `import 'server-only'`, mà client component (nút Copy) cần dùng hàm này → import từ đó
 * là nổ build. File này thuần logic, server lẫn client đều dùng được.
 */
export type SheetState = 'chưa copy' | 'đã copy';

const VN_OFFSET_MS = 7 * 3600 * 1000; // UTC+7, không DST

// Nửa đêm hôm nay theo giờ VN, quy về mốc UTC (ms). Nhận `now` từ ngoài để hàm thuần —
// giống relativeVN() trong lib/date.ts; startOfTodayVNISO() ở đó tự gọi Date.now() nên
// không dùng lại được trong render.
function startOfTodayVN(now: number): number {
  const vn = new Date(now + VN_OFFSET_MS);
  return Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - VN_OFFSET_MS;
}

/**
 * Dấu "đã copy" chỉ còn giá trị khi nó nói về ĐÚNG dữ liệu đang hiển thị VÀ đúng ngày làm
 * việc hôm nay. Ba thứ làm nó hết hạn:
 *
 *   1. sang ngày mới (00:00 VN) — nhịp làm việc là copy hằng ngày, dấu của hôm qua không
 *      nói được gì về hôm nay, kể cả khi chưa có bài mới nào;
 *   2. cào lại sau lần copy — lượt cào có thể sửa/bổ sung caption, comment của bài cũ chứ
 *      không chỉ thêm bài mới, nên bảng đã copy coi như cũ;
 *   3. có bài đăng mới hơn mốc copy.
 *
 * Hết hạn vì lý do nào cũng về 'chưa copy' — badge chỉ cần trả lời "giờ có phải copy không",
 * còn muốn biết đã từng copy lúc nào thì xem tooltip (copiedAt).
 *
 * `now` nhận null cho lúc render ở server của client component (useNow() chưa có giá trị):
 * khi đó bỏ qua riêng luật ngày, hai luật còn lại vẫn chạy.
 */
export function sheetState(
  copiedAt: string | null,
  newestPostAt: string | null,
  lastScrapedAt: string | null,
  now: number | null,
): SheetState {
  if (!copiedAt) return 'chưa copy';
  const copied = new Date(copiedAt).getTime();

  if (now !== null && copied < startOfTodayVN(now)) return 'chưa copy';
  if (lastScrapedAt && new Date(lastScrapedAt).getTime() > copied) return 'chưa copy';
  if (newestPostAt && new Date(newestPostAt).getTime() > copied) return 'chưa copy';
  return 'đã copy';
}
