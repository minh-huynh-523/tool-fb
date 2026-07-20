"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import { FB_COMMENT_MAX_CHARS } from "@/lib/constants";
import { CharCounter } from "./char-counter";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DateTimePicker } from "./datetime-picker";

export function AddCommentForm({
  postDbId,
  compact = false,
  onClose,
}: {
  postDbId: string;
  compact?: boolean;
  onClose?: () => void; // nút "Đóng" (chỉ ở compact). KHÔNG tự đóng sau khi thêm — để thấy dòng mới ở bảng lịch sử.
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [runAt, setRunAt] = useState(""); // "" = đăng ngay
  const [loading, setLoading] = useState(false);

  const overLimit = message.length > FB_COMMENT_MAX_CHARS;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() && !attachmentUrl.trim()) {
      toast.error("Cần nội dung hoặc link đính kèm");
      return;
    }
    if (overLimit) {
      toast.error(`Comment vượt quá ${FB_COMMENT_MAX_CHARS.toLocaleString("vi-VN")} ký tự — cắt bớt trước khi gửi.`);
      return;
    }
    setLoading(true);
    try {
      const { res, data } = await fetchJson(`/api/posts/${postDbId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, attachmentUrl, runAt }),
      });
      if (!res.ok) {
        toast.error(data.error ?? "Không thêm được comment");
        return;
      }
      toast.success(runAt ? "Đã hẹn giờ đăng comment." : "Đã đưa vào hàng đợi — sẽ đăng trong giây lát.");
      setMessage("");
      setAttachmentUrl("");
      setRunAt("");
      // Không đóng dòng — refresh để comment vừa thêm hiện ngay trong bảng lịch sử.
      router.refresh(); // hiện row PENDING
      // Refresh lại sau ít giây để thấy trạng thái SENT/FAILED (khi đăng ngay).
      setTimeout(() => router.refresh(), 4000);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className={compact ? "space-y-3" : "space-y-3 rounded-2xl border bg-card p-4"}>
      {!compact && <h2 className="font-medium">Thêm comment (vào hàng đợi)</h2>}
      <div className="space-y-1.5">
        <Label>Nội dung comment</Label>
        <Textarea
          placeholder="Nội dung comment…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
        />
        <CharCounter value={message} />
      </div>
      <div className="space-y-1.5">
        <Label>Link đính kèm (tuỳ chọn)</Label>
        <Input
          placeholder="vd link xem phim"
          value={attachmentUrl}
          onChange={(e) => setAttachmentUrl(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Đăng comment lúc</Label>
        <DateTimePicker value={runAt} onChange={setRunAt} />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={loading || overLimit}>
          {loading ? "Đang lưu…" : runAt ? "Hẹn giờ đăng" : "Gửi comment"}
        </Button>
        {compact && onClose && (
          <Button type="button" variant="outline" onClick={onClose}>
            Đóng
          </Button>
        )}
      </div>
    </form>
  );
}
