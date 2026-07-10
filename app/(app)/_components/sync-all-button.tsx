"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { Button } from "@/components/ui/button";

interface SyncRow {
  ok: boolean;
  name?: string;
  warning?: string;
}

export function SyncAllButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function syncAll() {
    setLoading(true);
    try {
      const { res, data } = await fetchJson("/api/pages/sync-all", { method: "POST" });
      if (!res.ok) {
        toast.error(data.error ?? "Đồng bộ thất bại");
        return;
      }
      const results = (data.results ?? []) as SyncRow[];
      const failed = results.filter((r) => !r.ok).length;
      const msg = `Đồng bộ ${data.total} bài từ ${results.length} page${failed ? ` (${failed} page lỗi)` : ""}`;
      if (failed) toast.error(msg);
      else toast.success(msg);
      // Cảnh báo riêng nếu không đọc được bài lên lịch (thiếu quyền token).
      for (const r of results) {
        if (r.warning) toast.info(`${r.name ?? "Page"}: ${r.warning}`);
      }
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={syncAll} disabled={loading}>
      <RefreshCw className={loading ? "animate-spin" : ""} />
      {loading ? "Đang đồng bộ…" : "Đồng bộ tất cả page"}
    </Button>
  );
}
