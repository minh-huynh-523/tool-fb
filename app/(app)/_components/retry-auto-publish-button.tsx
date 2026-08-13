"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/fetch-json";

// Chỉ hiện khi auto-publish (lib/auto-publish.ts) đang FAILED hẳn (hết MAX_ATTEMPTS tự thử lại) —
// bấm để reset về PENDING, cron tương ứng nhặt lại ngay lượt sau.
export function RetryAutoPublishButton({ postDbId }: { postDbId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function retry() {
    setLoading(true);
    try {
      const { res, data } = await fetchJson(`/api/posts/${postDbId}/auto-publish/retry`, { method: "POST" });
      if (!res.ok) return toast.error(data.error ?? "Thử lại thất bại");
      toast.success("Đã đưa bài trở lại hàng đợi auto-publish");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={retry} disabled={loading}>
      <RotateCw /> Thử lại
    </Button>
  );
}
