"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles, RefreshCw, Loader2, AlertTriangle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/fetch-json";
import { formatVN } from "@/lib/date";
import { CollapsibleText } from "./collapsible-text";
import { CopyButton } from "./copy-button";

// Kết quả Gemini cho 1 bài: 2 khối tách bạch (prompt ảnh / prompt video), mỗi khối copy
// riêng, kèm 1 nút "Tạo lại" cho cả cụm — hai prompt đến từ CÙNG một lần gọi API nên tạo
// lại riêng lẻ vừa vô nghĩa vừa tốn gấp đôi.

export interface PromptCellData {
  storyAnalysis: string | null;
  promptImage: string | null;
  promptVideo: string | null;
  promptRaw?: string | null;
  promptModel: string | null;
  promptAt: string | null;
  promptError: string | null;
}

// Trạng thái do lô (T10) áp từ ngoài vào; undefined = chạy đơn lẻ.
export type BatchStatus = "queued" | "running" | "error";

export function PromptCell({
  postId,
  hasCaption,
  initial,
  batchStatus,
  batchError,
}: {
  postId: string;
  hasCaption: boolean;
  initial: PromptCellData;
  batchStatus?: BatchStatus;
  batchError?: string;
}) {
  const router = useRouter();
  const [data, setData] = useState<PromptCellData>(initial);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const running = busy || batchStatus === "running";
  const queued = !running && batchStatus === "queued";

  async function generate() {
    setBusy(true);
    try {
      const { res, data: body } = await fetchJson(`/api/competitors/posts/${postId}/prompt`, { method: "POST" });
      if (!res.ok) return toast.error(body.error ?? "Lỗi tạo prompt");
      setData(body as PromptCellData);
      if (body.promptError) toast.warning(body.promptError);
      else toast.success("Đã tạo prompt");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (running) {
    return (
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        <Loader2 className="size-3.5 animate-spin" /> Đang phân tích…
      </div>
    );
  }

  if (queued) {
    return (
      <div className="flex items-center gap-2 text-xs text-neutral-400">
        <Clock className="size-3.5" /> Đang chờ
      </div>
    );
  }

  const hasAny = data.promptImage || data.promptVideo || data.promptRaw;

  if (!hasAny) {
    return (
      <div className="space-y-1.5">
        <Button size="sm" variant="outline" onClick={generate} disabled={!hasCaption}>
          <Sparkles /> Tạo prompt
        </Button>
        {!hasCaption && <div className="text-xs text-neutral-400">Bài không có caption</div>}
        {batchStatus === "error" && batchError && (
          <div className="flex items-start gap-1 text-xs text-red-600">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {batchError}
          </div>
        )}
        {data.promptError && (
          <div className="flex items-start gap-1 text-xs text-red-600">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {data.promptError}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-[280px] space-y-3">
      {data.promptImage && <PromptBlock title="Prompt ảnh" text={data.promptImage} copyLabel="Copy prompt ảnh" />}
      {data.promptVideo && <PromptBlock title="Prompt video" text={data.promptVideo} copyLabel="Copy prompt video" />}

      {data.promptError && (
        <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/40">
          <div className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {data.promptError}
          </div>
          {data.promptRaw && (
            <>
              <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setShowRaw(!showRaw)}>
                {showRaw ? "Ẩn bản gốc" : "Xem bản gốc"}
              </Button>
              {showRaw && (
                <div className="space-y-1.5">
                  <CopyButton text={data.promptRaw} label="Copy bản gốc" />
                  <CollapsibleText text={data.promptRaw} />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {data.storyAnalysis && (
        <details className="text-xs">
          <summary className="cursor-pointer text-neutral-500 hover:text-foreground">Phân tích truyện</summary>
          <div className="mt-1.5 space-y-1.5">
            <CopyButton text={data.storyAnalysis} label="Copy" />
            <CollapsibleText text={data.storyAnalysis} />
          </div>
        </details>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={generate}>
          <RefreshCw /> Tạo lại
        </Button>
        <span className="text-xs text-neutral-400">
          {data.promptModel ?? "—"}
          {data.promptAt ? ` · ${formatVN(data.promptAt)}` : ""}
        </span>
      </div>
    </div>
  );
}

function PromptBlock({ title, text, copyLabel }: { title: string; text: string; copyLabel: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-neutral-500">{title}</span>
        <CopyButton text={text} label={copyLabel} />
      </div>
      <CollapsibleText text={text} />
    </div>
  );
}
