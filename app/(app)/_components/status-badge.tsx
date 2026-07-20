import { Badge } from "@/components/ui/badge";
import type { CommentStatus } from "@/lib/types";

const MAP: Record<CommentStatus, { label: string; cls: string }> = {
  PENDING: { label: "Trong hàng đợi", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  PROCESSING: { label: "Đang gửi", cls: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  SENT: { label: "Đã đăng", cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  FAILED: { label: "Lỗi", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
};

// Cùng màu cam như PENDING sẽ khiến "đang chờ thử lại" trông y hệt "chờ lần đầu" — dùng cam đậm
// hơn để lướt bảng vẫn nhận ra ngay là comment này đã hỏng ít nhất một lần.
const RETRY_CLS = "bg-orange-200 text-orange-900 dark:bg-orange-950 dark:text-orange-200";

export function StatusBadge({
  status,
  attempts = 0,
}: {
  status: CommentStatus | null;
  attempts?: number | null;
}) {
  if (!status) {
    return (
      <Badge variant="secondary" className="text-muted-foreground">
        Chưa comment
      </Badge>
    );
  }
  // PENDING + đã từng gửi hỏng = worker đang đợi hết backoff để bắn lại.
  if (status === "PENDING" && (attempts ?? 0) > 0) {
    return <Badge className={`border-transparent ${RETRY_CLS}`}>Chờ thử lại (lần {(attempts ?? 0) + 1})</Badge>;
  }
  const s = MAP[status];
  return <Badge className={`border-transparent ${s.cls}`}>{s.label}</Badge>;
}
