import { formatVN } from "@/lib/date";
import type { SheetState } from "@/lib/sheet-state";

// Nhãn "page này có phải copy sang Sheet không". Dùng ở cả trang danh sách lẫn trang chi tiết.
// Dấu 'đã copy' hết hạn khi sang ngày mới / cào lại / có bài mới — xem sheetState().
const STYLE: Record<SheetState, string> = {
  "đã copy": "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  "chưa copy": "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
};

export function SheetStateBadge({ state, copiedAt }: { state: SheetState; copiedAt: string | null }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STYLE[state]}`}
      title={copiedAt ? `Lần copy gần nhất: ${formatVN(copiedAt)}` : "Chưa bấm Copy bảng cho Sheet lần nào"}
    >
      {state}
    </span>
  );
}
