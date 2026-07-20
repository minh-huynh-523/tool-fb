"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { EyeOff, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/fetch-json";

// "Bỏ qua" = tôi đã cân nhắc bài này và quyết định KHÔNG viết bài WP cho nó.
// Không có nút này thì hàng đợi chỉ tăng chứ không giảm, badge kẹt số dương và hết ý nghĩa.
export function DismissWpButton({ postDbId, dismissed }: { postDbId: string; dismissed: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function toggle() {
    setLoading(true);
    try {
      const { res, data } = await fetchJson(`/api/posts/${postDbId}/wp-dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissed: !dismissed }),
      });
      if (!res.ok) return toast.error(data.error ?? "Lỗi");
      toast.success(dismissed ? "Đã đưa bài trở lại hàng đợi" : "Đã bỏ qua bài này");
      // refresh() nạp lại cả layout -> badge sidebar tự cập nhật, không phải chờ vòng poll 60s.
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={toggle} disabled={loading}>
      {dismissed ? (
        <>
          <Undo2 /> Bỏ qua ✓
        </>
      ) : (
        <>
          <EyeOff /> Bỏ qua
        </>
      )}
    </Button>
  );
}
