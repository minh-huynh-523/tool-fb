"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, Loader2, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchJson } from "@/lib/fetch-json";

// Chạy CẢ 3 bước auto-publish (lib/auto-publish.ts) NGAY thay vì đợi cron ngoài — enqueue bài đủ
// ngưỡng -> sinh nội dung Gemini -> ĐĂNG THẬT lên WordPress + comment THẬT lên Facebook.
//
// Có thêm ô ngày để BACKFILL 1 ngày cụ thể trong quá khứ (vd bỏ lỡ, hoặc mới đổi ngưỡng) — enqueue
// vẫn dùng ĐÚNG ngưỡng reaction/comment như đường chạy tự động thường ngày (xem route), chỉ khác
// cửa sổ thời gian xét bài (cả ngày đã chọn, giờ VN, thay vì "hôm nay từ giờ cắt").
export function RunAutoPublishButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [date, setDate] = useState("");

  async function run() {
    const scope = date ? `bài ngày ${date}` : "bài đủ điều kiện hôm nay";
    const ok = window.confirm(
      `Chạy auto-publish cho ${scope}?\n\nSẽ ĐĂNG THẬT bài lên WordPress và comment THẬT lên Facebook (tối đa vài bài mỗi lượt bấm) — không phải bản xem trước.`,
    );
    if (!ok) return;

    setLoading(true);
    try {
      const url = date ? `/api/auto-publish/run?date=${date}` : "/api/auto-publish/run";
      const { res, data } = await fetchJson(url, { method: "POST" });
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
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <CalendarClock className="size-4 shrink-0" />
        <Input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-9 w-40"
          title="Để trống = hôm nay (mặc định); chọn ngày = backfill ngày đó"
        />
      </div>
      <Button variant="outline" onClick={run} disabled={loading}>
        {loading ? <Loader2 className="animate-spin" /> : <Rocket />}
        {loading ? "Đang chạy…" : date ? `Chạy cho ngày ${date}` : "Chạy auto-publish ngay"}
      </Button>
    </div>
  );
}
