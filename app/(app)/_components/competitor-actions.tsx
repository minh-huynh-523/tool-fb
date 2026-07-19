"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Trash2 } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";

// Nút "Cào ngay" (đặt scrape_requested_at) + bật/tắt active + xoá. KHÔNG cào trên Vercel —
// worker ở laptop poll thấy scrape_requested_at sẽ cào (chờ ~1 phút).
export function CompetitorActions({
  id,
  active,
  compact,
}: {
  id: string;
  active: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  async function call(patch: Record<string, unknown>, okMsg: string, key: string) {
    setLoading(key);
    try {
      const { res, data } = await fetchJson(`/api/competitors/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return toast.error(data.error ?? "Lỗi");
      toast.success(okMsg);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  async function remove() {
    if (!confirm("Xoá page này khỏi danh sách theo dõi? (mất luôn post/comment đã cào)")) return;
    setLoading("del");
    try {
      const { res, data } = await fetchJson(`/api/competitors/${id}`, { method: "DELETE" });
      if (!res.ok) return toast.error(data.error ?? "Lỗi");
      toast.success("Đã xoá");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        onClick={() => call({ requestScrape: true }, "Đã gửi yêu cầu cào — laptop sẽ cào trong ~1 phút", "scrape")}
        disabled={loading !== null}
        title="Đặt yêu cầu cào; worker ở laptop sẽ nhận"
        className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs font-medium transition hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        <RefreshCw className={loading === "scrape" ? "size-3.5 animate-spin" : "size-3.5"} />
        Cào ngay
      </button>
      <button
        onClick={() => call({ active: !active }, active ? "Đã tạm dừng" : "Đã bật theo dõi", "active")}
        disabled={loading !== null}
        className="rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs font-medium transition hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {active ? "Tạm dừng" : "Bật"}
      </button>
      {!compact && (
        <button
          onClick={remove}
          disabled={loading !== null}
          title="Xoá khỏi danh sách"
          className="rounded-lg border border-neutral-300 p-1.5 text-red-600 transition hover:bg-red-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-red-950"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}
