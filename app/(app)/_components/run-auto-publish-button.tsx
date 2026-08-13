"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/fetch-json";

// Chạy CẢ 3 bước auto-publish (lib/auto-publish.ts) NGAY thay vì đợi cron ngoài — enqueue bài đủ
// ngưỡng -> sinh nội dung Gemini -> ĐĂNG THẬT lên WordPress + comment THẬT lên Facebook.
export function RunAutoPublishButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function run() {
    const ok = window.confirm(
      "Chạy auto-publish ngay?\n\nSẽ ĐĂNG THẬT bài lên WordPress và comment THẬT lên Facebook cho các bài đủ điều kiện (tối đa vài bài mỗi lượt bấm) — không phải bản xem trước.",
    );
    if (!ok) return;

    setLoading(true);
    try {
      const { res, data } = await fetchJson("/api/auto-publish/run", { method: "POST" });
      if (!res.ok) return toast.error(data.error ?? "Chạy auto-publish thất bại");
      const { enqueue, content, publish } = data as {
        enqueue: { enqueued: number };
        content: { done: number; failed: number };
        publish: { published: number; commented: number; failed: number };
      };
      toast.success(
        `Enqueue ${enqueue.enqueued} bài mới · Sinh nội dung ${content.done} xong/${content.failed} lỗi · ` +
          `Đăng WP ${publish.published} xong/${publish.failed} lỗi (${publish.commented} đã comment)`,
        { duration: 10_000 },
      );
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="outline" onClick={run} disabled={loading}>
      {loading ? <Loader2 className="animate-spin" /> : <Rocket />}
      {loading ? "Đang chạy…" : "Chạy auto-publish ngay"}
    </Button>
  );
}
