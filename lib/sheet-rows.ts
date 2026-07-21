/**
 * Chọn bài nào sẽ đi vào bảng copy cho Google Sheet.
 *
 * Để RIÊNG khỏi component (và không `server-only`) vì cùng lý do với lib/sheet-state.ts: đây là
 * logic có nhiều ca biên đáng kiểm chứ không phải chuyện render, tách ra thì test được bằng script.
 */

/** Chỉ cần 3 trường này để quyết định — nhận kiểu hẹp để hàm dùng được cho cả bài đối thủ lẫn chỗ khác. */
export interface SheetRowCandidate {
  id: string;
  fb_created_at: string | null;
  sheet_copied_at: string | null;
}

/**
 * Hai chế độ, quyết định bằng việc CÓ tick dòng nào hay không:
 *
 *  - Có tick  -> lấy ĐÚNG mấy bài được tick, KHÔNG lọc gì thêm: không lọc giờ, và CỐ Ý không bỏ
 *                bài đã copy. Tick tay là lệnh tường minh — hay dùng khi cần dán lại bài đã lỡ
 *                xoá khỏi Sheet; im lặng bỏ qua thì user tưởng nút hỏng.
 *  - Không tick -> mặc định: bài đăng trong `windowHours` giờ gần nhất VÀ CHƯA từng copy.
 *                Bỏ bài đã copy là điểm mấu chốt: worker cào 6h/lần nên hai lượt liền nhau chồng
 *                lấn rất nhiều bài, thiếu vế này là dán trùng vào Sheet.
 *
 * Luôn giữ THỨ TỰ của mảng `posts` (bảng đang sort mới nhất trước), không theo thứ tự bấm chuột —
 * dán vào Sheet mà thứ tự nhảy theo tay người bấm thì rất khó đối chiếu.
 *
 * `now === null` là lúc render ở server của client component (useNow() chưa có giá trị): khi đó
 * cửa sổ giờ chưa tính được nên trả rỗng, NHƯNG chế độ chọn tay vẫn chạy vì nó không cần đồng hồ.
 *
 * Bài `fb_created_at === null` bị loại ở chế độ mặc định — không chứng minh được là bài mới.
 */
export function pickSheetRows<T extends SheetRowCandidate>(
  posts: T[],
  selectedIds: Set<string>,
  windowHours: number,
  now: number | null,
): T[] {
  if (selectedIds.size > 0) return posts.filter((p) => selectedIds.has(p.id));
  if (now === null) return [];
  const cutoff = now - windowHours * 3600_000;
  return posts.filter(
    (p) => !p.sheet_copied_at && p.fb_created_at && new Date(p.fb_created_at).getTime() >= cutoff,
  );
}
