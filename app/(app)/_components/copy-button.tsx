"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

// Nút copy nhanh 1 đoạn text (caption / comment). Đổi icon 1.5s khi copy xong.
export function CopyButton({ text, label, title }: { text: string; label?: string; title?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Đã sao chép");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Không sao chép được — copy thủ công");
    }
  }

  return (
    <button
      onClick={copy}
      title={title ?? "Sao chép"}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 px-1.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
      {label}
    </button>
  );
}
