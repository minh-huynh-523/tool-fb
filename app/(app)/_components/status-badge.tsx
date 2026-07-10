import { Badge } from "@/components/ui/badge";
import type { CommentStatus } from "@/lib/types";

const MAP: Record<CommentStatus, { label: string; cls: string }> = {
  PENDING: { label: "Trong hàng đợi", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  PROCESSING: { label: "Đang gửi", cls: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  SENT: { label: "Đã đăng", cls: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  FAILED: { label: "Lỗi", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
};

export function StatusBadge({ status }: { status: CommentStatus | null }) {
  if (!status) {
    return (
      <Badge variant="secondary" className="text-muted-foreground">
        Chưa comment
      </Badge>
    );
  }
  const s = MAP[status];
  return <Badge className={`border-transparent ${s.cls}`}>{s.label}</Badge>;
}
