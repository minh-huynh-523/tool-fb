"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy, ExternalLink, FileText, Loader2, MessageSquarePlus } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { Badge } from "@/components/ui/badge";
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

// Override ảnh đại diện ở bước preview: giữ ảnh cào về / bỏ ảnh / dán link mới / upload file từ máy.
type ImageOverride =
  | { kind: "auto" }
  | { kind: "none" }
  | { kind: "url"; url: string }
  | { kind: "file"; file: File; objectUrl: string };

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // Vercel cap body ~4.5MB

// Verify permalink trước khi dùng (copy/đăng comment): link phải sống (HTTP 200) và
// nội dung khớp title bài — chặn link 404 (bài còn draft, slug sai, row cũ dạng ?p=).
// Server tự chữa wp_permalink trong DB nếu WP trả link mới -> trả về link chuẩn để dùng.
async function verifyPermalink(postDbId: string): Promise<{ ok: boolean; permalink: string | null }> {
  try {
    const { res, data } = await fetchJson(`/api/posts/${postDbId}/wordpress/verify`, { method: "POST" });
    if (!res.ok || !data.ok) {
      toast.error(data.message ?? data.error ?? "Link chưa hợp lệ — kiểm tra bài trên WP");
      return { ok: false, permalink: data.permalink ?? null };
    }
    return { ok: true, permalink: data.permalink };
  } catch (e) {
    toast.error((e as Error).message);
    return { ok: false, permalink: null };
  }
}

// Nút copy permalink vào clipboard — verify link sống + đúng nội dung trước khi copy.
function CopyPermalinkButton({ postDbId, url, label }: { postDbId: string; url: string; label?: string }) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  async function copy() {
    setChecking(true);
    try {
      const v = await verifyPermalink(postDbId);
      if (!v.ok) return;
      const link = v.permalink ?? url;
      if (link !== url) router.refresh(); // DB vừa được chữa link -> refresh UI
      try {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        toast.success("Link OK (đã kiểm tra) — đã sao chép");
        setTimeout(() => setCopied(false), 1500);
      } catch {
        toast.error("Không sao chép được — hãy copy thủ công");
      }
    } finally {
      setChecking(false);
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={copy} disabled={checking} title={url}>
      {checking ? <Loader2 className="animate-spin" /> : copied ? <Check className="text-green-600" /> : <Copy />}
      {label ?? "Copy link"}
    </Button>
  );
}

// Nút lên lịch 1 comment chứa permalink WP, đăng TRÙNG GIỜ với first comment (run_after sớm nhất).
// Chỉ enable khi post đã có ít nhất 1 scheduled comment; chống trùng nếu permalink đã lên lịch.
function ScheduleCommentButton({
  postDbId,
  permalink,
  commentsInfo,
}: {
  postDbId: string;
  permalink: string;
  commentsInfo?: { firstRunAfter: string | null; texts: string[] };
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const alreadyScheduled = done || (commentsInfo?.texts ?? []).some((t) => t.includes(permalink));
  const firstRunAfter = commentsInfo?.firstRunAfter ?? null;

  if (alreadyScheduled) {
    return (
      <Badge className="border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300">
        <Check className="size-3" /> Đã lên lịch comment
      </Badge>
    );
  }

  async function schedule() {
    if (!firstRunAfter) return;
    setLoading(true);
    try {
      // Verify link sống + đúng nội dung trước — không lên lịch comment chứa link 404.
      const v = await verifyPermalink(postDbId);
      if (!v.ok) return;
      const link = v.permalink ?? permalink;
      const { res, data } = await fetchJson(`/api/posts/${postDbId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `Full story: ${link}`,
          runAtISO: firstRunAfter,
        }),
      });
      if (!res.ok) {
        toast.error(data.error ?? "Lên lịch comment thất bại");
        return;
      }
      setDone(true);
      toast.success("Đã lên lịch comment permalink (trùng giờ first comment)");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={schedule}
      disabled={loading || !firstRunAfter}
      title={
        firstRunAfter
          ? "Lên lịch comment chứa permalink, đăng trùng giờ với first comment. Nhớ publish bài WP trước giờ đó."
          : "Post chưa có first comment — hãy lên lịch first comment trước"
      }
    >
      {loading ? <Loader2 className="animate-spin" /> : <MessageSquarePlus />}
      Đăng vào comment
    </Button>
  );
}

export function WordpressPostButton({
  postDbId,
  existing,
  commentsInfo,
}: {
  postDbId: string;
  existing?: { editUrl: string | null; status: string | null; permalink: string | null } | null;
  // Thông tin comment đã lên lịch của post: giờ first comment + nội dung (check trùng permalink).
  commentsInfo?: { firstRunAfter: string | null; texts: string[] };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [image, setImage] = useState<ImageOverride>({ kind: "auto" });
  const [imageUrlInput, setImageUrlInput] = useState("");
  const [published, setPublished] = useState<{
    editUrl: string | null;
    permalink: string | null;
    status: "draft" | "publish";
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Đã tạo bài WP -> mở bài/nháp + copy permalink + option đăng permalink vào comment.
  if (existing?.editUrl) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          <a href={existing.editUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink /> {existing.status === "publish" ? "Mở bài WP" : "Mở nháp WP"}
          </a>
        </Button>
        {existing.permalink && (
          <>
            <CopyPermalinkButton postDbId={postDbId} url={existing.permalink} />
            <ScheduleCommentButton postDbId={postDbId} permalink={existing.permalink} commentsInfo={commentsInfo} />
          </>
        )}
      </div>
    );
  }

  function setImageOverride(next: ImageOverride) {
    setImage((prev) => {
      if (prev.kind === "file") URL.revokeObjectURL(prev.objectUrl);
      return next;
    });
  }

  function reset() {
    setUrl("");
    setPreview(null);
    setTitle("");
    setImageOverride({ kind: "auto" });
    setImageUrlInput("");
    setPublished(null);
  }

  // Ảnh đại diện đang hiển thị theo override.
  const effectiveImageSrc =
    image.kind === "file"
      ? image.objectUrl
      : image.kind === "url"
        ? image.url
        : image.kind === "auto"
          ? (preview?.imageUrl ?? null)
          : null;

  function applyImageUrl() {
    const raw = imageUrlInput.trim();
    try {
      const u = new URL(raw);
      if (!u.protocol.startsWith("http")) throw new Error();
    } catch {
      toast.error("Link ảnh không hợp lệ");
      return;
    }
    setImageOverride({ kind: "url", url: raw });
  }

  function applyImageFile(file: File | undefined | null) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("File không phải ảnh");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error("Ảnh quá lớn (tối đa 4MB)");
      return;
    }
    setImageOverride({ kind: "file", file, objectUrl: URL.createObjectURL(file) });
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
      setImageOverride({ kind: "auto" });
      setImageUrlInput("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // BƯỚC 2: xác nhận -> đăng (draft hoặc publish luôn) với title + ảnh đại diện đã duyệt (multipart để gửi được file).
  async function doPublish(status: "draft" | "publish") {
    if (!title.trim()) {
      toast.error("Tiêu đề không được trống");
      return;
    }
    setLoading(true);
    try {
      const fd = new FormData();
      fd.set("sourceUrl", url.trim());
      fd.set("title", title.trim());
      fd.set("imageMode", image.kind === "file" ? "upload" : image.kind);
      if (image.kind === "url") fd.set("imageUrl", image.url);
      if (image.kind === "file") fd.set("imageFile", image.file);
      fd.set("wpStatus", status);
      // KHÔNG set Content-Type — browser tự set boundary multipart.
      const { res, data } = await fetchJson(`/api/posts/${postDbId}/wordpress`, { method: "POST", body: fd });
      if (!res.ok) {
        toast.error(data.error ?? (status === "publish" ? "Đăng bài thất bại" : "Đăng nháp thất bại"));
        return;
      }
      toast.success(status === "publish" ? "Đã đăng bài trên WordPress" : "Đã tạo bản nháp trên WordPress");
      setPublished({ editUrl: data.editUrl ?? null, permalink: data.permalink ?? null, status });
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
          <DialogTitle>Tạo bài WordPress</DialogTitle>
          <DialogDescription>
            B1: cào bài gốc → B2: xác nhận tiêu đề + ảnh → đăng nháp hoặc đăng luôn lên site WordPress của page
            này (cấu hình ở trang Pages).
          </DialogDescription>
        </DialogHeader>

        {published ? (
          <>
            {/* Đăng xong: permalink + copy + mở bài/nháp + option đăng vào comment */}
            <div className="space-y-3">
              <p className="text-sm">
                {published.status === "publish" ? "Đã đăng bài trên WordPress." : "Đã tạo bản nháp trên WordPress."}
              </p>
              {published.permalink && (
                <div className="space-y-1.5">
                  <Label>Permalink</Label>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={published.permalink} onFocus={(e) => e.currentTarget.select()} />
                    <CopyPermalinkButton postDbId={postDbId} url={published.permalink} label="Copy" />
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {published.editUrl && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={published.editUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink /> {published.status === "publish" ? "Mở bài WP" : "Mở nháp WP"}
                    </a>
                  </Button>
                )}
                {published.permalink && (
                  <ScheduleCommentButton
                    postDbId={postDbId}
                    permalink={published.permalink}
                    commentsInfo={commentsInfo}
                  />
                )}
              </div>
              {published.status === "draft" && (
                <p className="text-xs text-muted-foreground">
                  Bài đang ở dạng nháp — nút Copy/Đăng vào comment sẽ kiểm tra link thật và chỉ chạy sau khi bài đã
                  publish trên WP.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Đóng</Button>
            </DialogFooter>
          </>
        ) : !preview ? (
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
              {/* Ảnh đại diện — sửa được: dán link / upload từ máy / bỏ ảnh */}
              <div className="space-y-1.5">
                <Label className="flex items-center gap-2">
                  Ảnh đại diện
                  <Badge variant="secondary">
                    {image.kind === "auto" ? "ảnh gốc" : image.kind === "none" ? "đã bỏ ảnh" : "ảnh mới"}
                  </Badge>
                </Label>
                {effectiveImageSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={effectiveImageSrc}
                    alt=""
                    className="max-h-40 w-full rounded-lg object-cover"
                    onError={() => {
                      if (image.kind === "url") {
                        toast.error("Không tải được ảnh từ link — dùng lại ảnh gốc");
                        setImageOverride({ kind: "auto" });
                      }
                    }}
                  />
                ) : (
                  <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                    Không có ảnh đại diện
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Dán link ảnh mới…"
                    value={imageUrlInput}
                    onChange={(e) => setImageUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        applyImageUrl();
                      }
                    }}
                  />
                  <Button variant="outline" size="sm" onClick={applyImageUrl} disabled={!imageUrlInput.trim()}>
                    Dùng link
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="max-w-56 text-xs"
                    onChange={(e) => {
                      applyImageFile(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  <Button variant="ghost" size="sm" onClick={() => setImageOverride({ kind: "none" })}>
                    Bỏ ảnh
                  </Button>
                  {image.kind !== "auto" && (
                    <Button variant="ghost" size="sm" onClick={() => setImageOverride({ kind: "auto" })}>
                      Khôi phục ảnh gốc
                    </Button>
                  )}
                </div>
              </div>
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
              Đăng vào category <span className="font-medium text-foreground">Story</span> — chọn{" "}
              <span className="font-medium text-foreground">Đăng nháp</span> (draft) hoặc{" "}
              <span className="font-medium text-foreground">Đăng luôn</span> (publish công khai ngay).
            </p>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" onClick={() => setPreview(null)} disabled={loading}>
                Cào lại
              </Button>
              <Button variant="secondary" onClick={() => doPublish("draft")} disabled={loading || !title.trim()}>
                {loading ? (
                  <>
                    <Loader2 className="animate-spin" /> Đang đăng…
                  </>
                ) : (
                  "Đăng nháp"
                )}
              </Button>
              <Button onClick={() => doPublish("publish")} disabled={loading || !title.trim()}>
                {loading ? (
                  <>
                    <Loader2 className="animate-spin" /> Đang đăng…
                  </>
                ) : (
                  "Đăng luôn"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
