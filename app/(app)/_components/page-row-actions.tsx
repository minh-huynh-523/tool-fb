"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";

export function PageRowActions({ pageId }: { pageId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"" | "test" | "sync">("");
  const [note, setNote] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  async function testToken() {
    setBusy("test");
    setNote(null);
    try {
      const { data } = await fetchJson(`/api/pages/${encodeURIComponent(pageId)}/test-token`);
      if (data.ok) {
        toast.success(`Token OK — ${data.name}`);
        setNote({ type: "ok", text: `Token OK — ${data.name}` });
      } else {
        toast.error(data.error ?? "Token lỗi");
        setNote({ type: "err", text: data.error ?? "Token lỗi" });
      }
    } catch (e) {
      toast.error((e as Error).message);
      setNote({ type: "err", text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  async function sync() {
    setBusy("sync");
    setNote(null);
    try {
      const { res, data } = await fetchJson(`/api/pages/${encodeURIComponent(pageId)}/sync`, { method: "POST" });
      if (res.ok) {
        const count = data.result?.count ?? 0;
        toast.success(`Đồng bộ: ${count} bài`);
        setNote({ type: "ok", text: `Đồng bộ: ${count} bài` });
        if (data.result?.warning) toast.info(data.result.warning);
        router.refresh();
      } else {
        const err = data.result?.error ?? data.error ?? "Lỗi đồng bộ";
        toast.error(err);
        setNote({ type: "err", text: err });
      }
    } catch (e) {
      toast.error((e as Error).message);
      setNote({ type: "err", text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <button
          onClick={testToken}
          disabled={!!busy}
          className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs transition hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {busy === "test" ? "…" : "Test token"}
        </button>
        <button
          onClick={sync}
          disabled={!!busy}
          className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs transition hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {busy === "sync" ? "…" : "Đồng bộ"}
        </button>
      </div>
      {note && (
        <span className={`text-xs ${note.type === "ok" ? "text-green-600" : "text-red-600"}`}>{note.text}</span>
      )}
    </div>
  );
}
