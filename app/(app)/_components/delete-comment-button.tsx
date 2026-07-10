"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { CommentStatus } from "@/lib/types";

export function DeleteCommentButton({
  postDbId,
  comment,
}: {
  postDbId: string;
  comment: { id: string; message: string; status: CommentStatus };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Chỉ huỷ được khi chưa gửi (PENDING) hoặc gửi lỗi (FAILED). Đã đăng thì là lịch sử — giữ lại.
  if (comment.status !== "PENDING" && comment.status !== "FAILED") return null;

  async function doDelete() {
    setLoading(true);
    try {
      const { res, data } = await fetchJson(`/api/posts/${postDbId}/comments/${comment.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(data.error ?? "Không xoá được comment");
        return;
      }
      toast.success("Đã huỷ comment đã lên lịch.");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" aria-label="Huỷ comment">
          <Trash2 />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Huỷ comment đã lên lịch?</DialogTitle>
          <DialogDescription className="line-clamp-3">
            {comment.message ? `"${comment.message}"` : "(chỉ đính kèm link)"}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            Giữ lại
          </Button>
          <Button variant="destructive" onClick={doDelete} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="animate-spin" /> Đang xoá…
              </>
            ) : (
              "Xoá"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
