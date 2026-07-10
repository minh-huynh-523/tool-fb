"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export function AddPageForm() {
  const router = useRouter();
  const [pageId, setPageId] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_id: pageId.trim(), name: name.trim(), access_token: token.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Lỗi không xác định");
        setMsg({ type: "err", text: data.error ?? "Lỗi không xác định" });
        return;
      }
      toast.success(`Đã lưu page: ${data.page?.name ?? pageId}`);
      setMsg({ type: "ok", text: `Đã lưu page: ${data.page?.name ?? pageId}` });
      setPageId("");
      setName("");
      setToken("");
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
      className="space-y-3 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <h2 className="font-medium">Thêm page (copy từ hercules channels)</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <input
          placeholder="page_id (= channels.app_id)"
          value={pageId}
          onChange={(e) => setPageId(e.target.value)}
          required
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
        <input
          placeholder="Tên (bỏ trống = lấy từ FB)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
        <input
          placeholder="access_token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
      </div>
      {msg && (
        <p className={`text-sm ${msg.type === "ok" ? "text-green-600" : "text-red-600"}`}>{msg.text}</p>
      )}
      <button
        type="submit"
        disabled={loading}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
      >
        {loading ? "Đang kiểm tra token…" : "Thêm / cập nhật"}
      </button>
    </form>
  );
}
