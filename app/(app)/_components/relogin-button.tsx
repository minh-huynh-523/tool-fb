"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LogIn } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";

// Bấm -> mở Chrome headful THẬT trên máy đang chạy `npm run dev` (xem app/api/scraper/relogin).
// Trên Vercel route tự chặn và trả lỗi rõ ràng — nút vẫn hiện nhưng sẽ báo lỗi hướng dẫn chạy local.
export function ReloginButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function relogin() {
    setLoading(true);
    toast.info("Đang mở Chrome — đăng nhập trong cửa sổ vừa mở, tự phát hiện xong (tới 5 phút).");
    try {
      const { res, data } = await fetchJson("/api/scraper/relogin", { method: "POST" });
      if (!res.ok || !data.ok) return toast.error(data.message ?? "Đăng nhập lại thất bại");
      toast.success(data.message ?? "Đã đăng nhập lại");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={relogin}
      disabled={loading}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-400 bg-amber-100 px-2.5 py-1.5 text-xs font-medium text-amber-800 transition hover:bg-amber-200 disabled:opacity-60 dark:border-amber-700 dark:bg-amber-900/60 dark:text-amber-200 dark:hover:bg-amber-900"
    >
      <LogIn className={loading ? "size-3.5 animate-pulse" : "size-3.5"} />
      {loading ? "Đang chờ đăng nhập..." : "Đăng nhập lại (máy local)"}
    </button>
  );
}
