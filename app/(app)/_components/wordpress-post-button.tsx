"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileText, ExternalLink, Loader2 } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Preview = { title: string; imageUrl: string | null; description: string; contentHtml: string; parts: number };

export function WordpressPostButton({
  postDbId,
  existing,
}: {
  postDbId: string;
  existing?: { editUrl: string | null; status: string | null } | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);

  // Đã tạo nháp -> nút mở nháp WP.
  if (existing?.editUrl) {
    return (
      <Button variant="outline" size="sm" asChild>
        <a href={existing.editUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink /> Mở nháp WP
        </a>
      </Button>
    );
  }

  function reset() {
    setUrl("");
    setPreview(null);
    setTitle("");
  }

  // BƯỚC 1: cào về để xem trước (title + ảnh + trích đoạn).
  async function doScrape() {
    if (!url.trim()) {
      toast.error("Cần nhập link bài gốc");
      return;
    }
    setLoading(true);
    try {
      const { res, data } = await fetchJson(`/api/posts/${postDbId}/wordpress/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: url.trim() }),
      });
      if (!res.ok) {
        toast.error(data.error ?? "Cào thất bại");
        return;
      }
      setPreview({
        title: data.title ?? "",
        imageUrl: data.imageUrl ?? null,
        description: data.description ?? "",
        contentHtml: data.contentHtml ?? "",
        parts: data.parts ?? 1,
      });
      setTitle(data.title ?? "");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // BƯỚC 2: xác nhận -> đăng nháp với title đã duyệt.
  async function doPublish() {
    if (!title.trim()) {
      toast.error("Tiêu đề không được trống");
      return;
    }
    setLoading(true);
    try {
      const { res, data } = await fetchJson(`/api/posts/${postDbId}/wordpress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceUrl: url.trim(), title: title.trim() }),
      });
      if (!res.ok) {
        toast.error(data.error ?? "Đăng nháp thất bại");
        return;
      }
      toast.success("Đã tạo bản nháp trên WordPress");
      setOpen(false);
      reset();
      router.refresh();
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
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileText /> Tạo bài WP
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tạo bài nháp WordPress</DialogTitle>
          <DialogDescription>
            B1: cào bài gốc → B2: xác nhận tiêu đề → đăng nháp (draft) trên life.kinhmatquangnhan.vn.
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="wp-source-url">Link bài gốc</Label>
              <Input
                id="wp-source-url"
                placeholder="https://1millionstories.net/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !loading) doScrape();
                }}
              />
            </div>
            <DialogFooter>
              <Button onClick={doScrape} disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="animate-spin" /> Đang cào…
                  </>
                ) : (
                  "Cào về"
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-3">
              {preview.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview.imageUrl} alt="" className="max-h-40 w-full rounded-lg object-cover" />
              )}
              <div className="space-y-1.5">
                <Label htmlFor="wp-title">Tiêu đề (giữ nguyên từ bài gốc — sửa được)</Label>
                <Textarea id="wp-title" rows={2} value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground">Mô tả (description)</Label>
                <p className="line-clamp-4 text-sm text-muted-foreground">{preview.description || "(trống)"}</p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-muted-foreground">
                  Nội dung cào về (xem full để validate)
                  {preview.parts > 1 && (
                    <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950 dark:text-green-300">
                      đã gộp {preview.parts} phần
                    </span>
                  )}
                </Label>
                <div
                  className="max-h-72 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-sm [&_a]:text-blue-600 [&_h2]:mt-3 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-medium [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded [&_p]:mb-2"
                  dangerouslySetInnerHTML={{ __html: preview.contentHtml || "<p>(trống)</p>" }}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Đăng nháp (draft) vào category <span className="font-medium text-foreground">Story</span>.
            </p>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" onClick={() => setPreview(null)} disabled={loading}>
                Cào lại
              </Button>
              <Button onClick={doPublish} disabled={loading || !title.trim()}>
                {loading ? (
                  <>
                    <Loader2 className="animate-spin" /> Đang đăng…
                  </>
                ) : (
                  "Đăng nháp"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
