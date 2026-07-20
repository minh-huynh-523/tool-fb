"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Loader2, Pencil } from "lucide-react";
import { isoToVnLocal } from "@/lib/date";
import { fetchJson } from "@/lib/fetch-json";
import { FB_COMMENT_MAX_CHARS } from "@/lib/constants";
import { CharCounter } from "./char-counter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DateTimePicker } from "./datetime-picker";
import type { CommentStatus } from "@/lib/types";

export function EditCommentButton({
  postDbId,
  comment,
}: {
  postDbId: string;
  comment: { id: string; message: string; attachment_url: string | null; run_after: string; status: CommentStatus };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(comment.message);
  const [attachmentUrl, setAttachmentUrl] = useState(comment.attachment_url ?? "");
  const [runAt, setRunAt] = useState(isoToVnLocal(comment.run_after));
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false); // bung Textarea để xem hết comment dài

  const longMessage = message.length > 200 || message.split("\n").length > 3;
  const overLimit = message.length > FB_COMMENT_MAX_CHARS;

  // Chỉ sửa được khi chưa gửi (PENDING) hoặc gửi lỗi (FAILED -> sửa xong thử lại).
  if (comment.status !== "PENDING" && comment.status !== "FAILED") return null;

  async function save() {
    if (!message.trim() && !attachmentUrl.trim()) {
      toast.error("Cần nội dung hoặc link đính kèm");
      return;
    }
    if (message.length > FB_COMMENT_MAX_CHARS) {
      toast.error(`Comment vượt quá ${FB_COMMENT_MAX_CHARS.toLocaleString("vi-VN")} ký tự — cắt bớt trước khi lưu.`);
      return;
    }
    setLoading(true);
    try {
      // Chỉ gửi runAt khi user THẬT SỰ đổi giờ — giữ nguyên run_after gốc (kể cả giây buffer).
      const payload: Record<string, string> = { message, attachmentUrl };
      if (runAt !== isoToVnLocal(comment.run_after)) payload.runAt = runAt;
      const { res, data } = await fetchJson(`/api/posts/${postDbId}/comments/${comment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        toast.error(data.error ?? "Không sửa được comment");
        return;
      }
      toast.success(runAt ? "Đã đổi lịch comment." : "Sẽ đăng ngay trong giây lát.");
      setOpen(false);
      router.refresh();
      setTimeout(() => router.refresh(), 4000); // cập nhật SENT/FAILED nếu đăng ngay
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          // Reset draft từ props mỗi lần mở — không giữ ngầm bản sửa dở đã huỷ lần trước.
          setMessage(comment.message);
          setAttachmentUrl(comment.attachment_url ?? "");
          setRunAt(isoToVnLocal(comment.run_after));
          setExpanded(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Sửa lịch comment">
          <Pencil /> Sửa
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sửa comment đã lên lịch</DialogTitle>
          <DialogDescription>
            Đổi giờ đăng hoặc nội dung. {comment.status === "FAILED" && "Comment lỗi sẽ được thử lại theo lịch mới."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="edit-cmt-msg">Nội dung comment</Label>
            <Textarea
              id="edit-cmt-msg"
              rows={expanded ? 16 : 3}
              className={expanded ? "max-h-[50vh] overflow-y-auto" : ""}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <CharCounter value={message} />
            {longMessage && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? (
                  <>
                    <ChevronUp /> Thu gọn
                  </>
                ) : (
                  <>
                    <ChevronDown /> Xem thêm
                  </>
                )}
              </Button>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-cmt-att">Link đính kèm (tuỳ chọn)</Label>
            <Input id="edit-cmt-att" value={attachmentUrl} onChange={(e) => setAttachmentUrl(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Đăng comment lúc</Label>
            <DateTimePicker value={runAt} onChange={setRunAt} />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            Huỷ
          </Button>
          <Button onClick={save} disabled={loading || overLimit}>
            {loading ? (
              <>
                <Loader2 className="animate-spin" /> Đang lưu…
              </>
            ) : (
              "Lưu"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
