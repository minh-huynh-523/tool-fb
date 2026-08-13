import { Badge } from "@/components/ui/badge";
import type { AutoPublishStatus } from "@/lib/queries";

// Cùng shape với status-badge.tsx (comment đã lên lịch) — badge riêng vì vocabulary trạng thái
// khác (DONE/PUBLISHED thay vì SENT) và có thêm khái niệm "stage" (content vs publish).
const LABEL: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "Chờ auto-publish", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  PROCESSING: { label: "Đang tự động", cls: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  DONE: { label: "Đã sinh nội dung", cls: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  PUBLISHED: { label: "Đã tự đăng WP", cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  FAILED: { label: "Auto-publish lỗi", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
};

// Cam đậm hơn PENDING thường: "đang chờ thử lại sau khi hỏng" phải nhận ra ngay khi lướt bảng,
// không lẫn với "mới vào hàng đợi, chưa chạy lần nào" — cùng lý do StatusBadge.
const RETRY_CLS = "bg-orange-200 text-orange-900 dark:bg-orange-950 dark:text-orange-200";

export function AutoPublishBadge({ autoPublish }: { autoPublish: AutoPublishStatus | null }) {
  if (!autoPublish) return null;
  const { status, attempts, error } = autoPublish;

  if (status === "PENDING" && attempts > 0) {
    return (
      <Badge className={`border-transparent ${RETRY_CLS}`} title={error ?? undefined}>
        Auto-publish: chờ thử lại (lần {attempts + 1})
      </Badge>
    );
  }
  const s = LABEL[status] ?? LABEL.PENDING;
  return (
    <Badge className={`border-transparent ${s.cls}`} title={status === "FAILED" ? (error ?? undefined) : undefined}>
      {s.label}
    </Badge>
  );
}
