"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import type { BatchStatus } from "./prompt-cell";

// Chạy "tạo prompt" cho nhiều bài. CỐ Ý điều phối ở client thay vì làm route batch:
// N bài × ~30-60s sẽ vượt maxDuration của Vercel và mất sạch tiến độ khi timeout.
// Client lặp gọi route đơn lẻ -> có tiến độ từng dòng, dừng được, một bài lỗi không kéo cả lô.

const CONCURRENCY = 3; // đủ nhanh, không đấm quota Gemini, UI vẫn mượt

export interface BatchTarget {
  id: string;
  hasCaption: boolean;
  hasPrompt: boolean;
}

export interface BatchState {
  running: boolean;
  done: number;
  total: number;
  status: Map<string, BatchStatus>;
  errors: Map<string, string>;
}

export function useBatchPrompt() {
  const router = useRouter();
  const abortRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<BatchState>({
    running: false,
    done: 0,
    total: 0,
    status: new Map(),
    errors: new Map(),
  });

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const run = useCallback(
    async (targets: BatchTarget[], overwrite: boolean) => {
      const skippedNoCaption = targets.filter((t) => !t.hasCaption).length;
      const skippedHasPrompt = overwrite ? 0 : targets.filter((t) => t.hasCaption && t.hasPrompt).length;
      const queue = targets.filter((t) => t.hasCaption && (overwrite || !t.hasPrompt));

      const skipped = skippedNoCaption + skippedHasPrompt;
      if (queue.length === 0) {
        toast.warning(`Không có bài nào để chạy (bỏ qua ${skipped} bài: đã có prompt / không caption)`);
        return;
      }
      if (skipped > 0) {
        toast.info(`Bỏ qua ${skipped} bài (đã có prompt / không caption)`);
      }

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const status = new Map<string, BatchStatus>(queue.map((t) => [t.id, "queued" as BatchStatus]));
      const errors = new Map<string, string>();
      setState({ running: true, done: 0, total: queue.length, status, errors });

      let done = 0;
      let ok = 0;
      let failed = 0;

      const bump = () =>
        setState((s) => ({ ...s, done, status: new Map(status), errors: new Map(errors) }));

      let next = 0;
      async function worker() {
        while (!ctrl.signal.aborted) {
          const i = next++;
          if (i >= queue.length) return;
          const t = queue[i];

          status.set(t.id, "running");
          bump();

          try {
            const { res, data } = await fetchJson(`/api/competitors/posts/${t.id}/prompt`, {
              method: "POST",
              signal: ctrl.signal,
            });
            if (res.ok) {
              ok++;
              status.delete(t.id); // xong -> trả dòng về hiển thị kết quả bình thường
            } else {
              failed++;
              status.set(t.id, "error");
              errors.set(t.id, data.error ?? "Lỗi không rõ");
            }
          } catch (e) {
            if (ctrl.signal.aborted) return;
            failed++;
            status.set(t.id, "error");
            errors.set(t.id, (e as Error).message);
          }
          done++;
          bump();
        }
      }

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

      // Các bài chưa kịp chạy: xoá trạng thái "đang chờ" để không kẹt spinner sau khi Dừng.
      if (ctrl.signal.aborted) {
        for (const [id, st] of status) if (st === "queued" || st === "running") status.delete(id);
      }

      setState((s) => ({ ...s, running: false, status: new Map(status), errors: new Map(errors) }));
      abortRef.current = null;

      const stopped = ctrl.signal.aborted ? " (đã dừng)" : "";
      toast[failed > 0 ? "warning" : "success"](
        `Xong ${ok} · lỗi ${failed} · bỏ qua ${skipped}${stopped}`,
      );
      // Refresh MỘT lần ở cuối — refresh sau mỗi bài sẽ giật và huỷ state của lô.
      router.refresh();
    },
    [router],
  );

  return { state, run, stop };
}
