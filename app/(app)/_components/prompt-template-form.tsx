"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/fetch-json";
import { formatVN } from "@/lib/date";

// 3 heading mà splitPromptSections() dựa vào để tách output — mất chúng thì app không
// tách được prompt ảnh / prompt video (vẫn còn "Xem bản gốc", nhưng mất tiện lợi).
const REQUIRED_HEADINGS = ["STORY ANALYSIS", "IMAGE PROMPT", "VIDEO PROMPT"];

export function PromptTemplateForm({
  kind,
  initialBody,
  updatedAt,
}: {
  kind: "main" | "part2";
  initialBody: string;
  updatedAt: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState(initialBody);
  const [saving, setSaving] = useState(false);

  const dirty = body !== initialBody;
  const missing = kind === "main" ? REQUIRED_HEADINGS.filter((h) => !body.toUpperCase().includes(h)) : [];

  async function save() {
    setSaving(true);
    try {
      const { res, data } = await fetchJson("/api/prompt-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, body }),
      });
      if (!res.ok) return toast.error(data.error ?? "Lưu thất bại");
      toast.success("Đã lưu mẫu prompt");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {kind === "main" ? (
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          <p>
            Giữ nguyên 3 heading <code>### STORY ANALYSIS</code>, <code>### IMAGE PROMPT</code>,{" "}
            <code>### VIDEO PROMPT</code> ở phần <b>OUTPUT FORMAT</b> — app dựa vào chúng để tách kết quả thành
            2 mục.
          </p>
          <p className="mt-1">
            Biến dùng được (không bắt buộc): <code>{"{{caption}}"}</code> — caption FB,{" "}
            <code>{"{{part2}}"}</code> — comment của page, <code>{"{{link}}"}</code> — link bài gốc. Nếu không
            dùng biến nào, caption sẽ tự được nối vào cuối prompt.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          <p>
            Chỉ chạy TỰ ĐỘNG lúc cào, cho bài KHÔNG có comment nào của page (xem cột &quot;Part 2&quot; ở trang
            Đối thủ) — không đè lên comment thật cào được.
          </p>
          <p className="mt-1">
            Biến dùng được: <code>{"{{caption}}"}</code> — caption FB bài đối thủ. Kết quả trả về được lưu
            nguyên văn làm Part 2, không tách mục.
          </p>
        </div>
      )}

      {missing.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Thiếu heading: <b>{missing.join(", ")}</b> — app sẽ không tách được mục tương ứng, chỉ còn nút
            &quot;Xem bản gốc&quot;.
          </span>
        </div>
      )}

      <Textarea
        rows={24}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="font-mono text-xs"
        spellCheck={false}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving || !dirty}>
          <Save /> {saving ? "Đang lưu…" : "Lưu"}
        </Button>
        <span className="text-xs text-neutral-400">
          {body.length.toLocaleString("vi-VN")} ký tự · cập nhật {formatVN(updatedAt)}
        </span>
      </div>
    </div>
  );
}
