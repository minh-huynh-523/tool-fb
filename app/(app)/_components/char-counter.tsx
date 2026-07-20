import { FB_COMMENT_MAX_CHARS } from "@/lib/constants";

/**
 * Bộ đếm ký tự cho ô soạn comment. Dùng chung ở form thêm mới và dialog sửa để hai chỗ không
 * lệch trần nhau. Chỉ là tiện lợi — chặn thật nằm ở API (client nào cũng bỏ qua được).
 */
export function CharCounter({ value, max = FB_COMMENT_MAX_CHARS }: { value: string; max?: number }) {
  const n = value.length;
  const over = n > max;
  // Im lặng khi còn xa trần: comment ngắn không cần thấy con số nào.
  if (n < max * 0.75) return null;
  return (
    <p className={`text-right text-xs tabular-nums ${over ? "font-medium text-red-600" : "text-muted-foreground"}`}>
      {n.toLocaleString("vi-VN")} / {max.toLocaleString("vi-VN")}
      {over && ` — vượt ${(n - max).toLocaleString("vi-VN")} ký tự, Facebook sẽ từ chối`}
    </p>
  );
}
