"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";

export function AddCompetitorForm() {
  const router = useRouter();
  const [handle, setHandle] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { res, data } = await fetchJson("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: handle.trim() }),
      });
      if (!res.ok) {
        toast.error(data.error ?? "Lỗi không xác định");
        return;
      }
      toast.success(`Đã thêm: ${data.handle}`);
      setHandle("");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-4 sm:flex-row sm:items-center dark:border-neutral-800 dark:bg-neutral-900"
    >
      <input
        placeholder="Handle hoặc URL (vd readfullstory2023 / facebook.com/61586…)"
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
        required
        className="flex-1 rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
      />
      <button
        type="submit"
        disabled={loading}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
      >
        {loading ? "Đang thêm…" : "Thêm page đối thủ"}
      </button>
    </form>
  );
}
