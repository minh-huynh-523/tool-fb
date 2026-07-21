"use client";

import { useMemo, useState } from "react";
import { Check, Table2 } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { collectPostLinks } from "@/lib/fb-link";
import { fetchJson } from "@/lib/fetch-json";
import { useNow } from "@/lib/use-now";
import { sheetState } from "@/lib/sheet-state";
import type { CompetitorPostWithComments } from "@/lib/queries";
import { SheetStateBadge } from "./sheet-state-badge";

// Xuất các bài MỚI trong N giờ thành TSV để dán thẳng sang Google Sheet.
// Thứ tự cột: Link Source | Link Post | Caption FB | Part 2 | Link Comment Post.
// KHÔNG có cột prompt (bảng này để làm nội dung) và KHÔNG có hàng tiêu đề.
const COLUMN_COUNT = 5;

/**
 * Bọc 1 ô cho đúng chuẩn dán vào Sheet.
 * Caption/part 2 gần như luôn có xuống dòng, mà TSV lấy \n làm dấu hết HÀNG → không bọc thì
 * 1 bài vỡ thành chục hàng. Sheet hiểu quy ước CSV: ô nào chứa tab/xuống dòng/dấu nháy thì
 * bọc trong " và nhân đôi " bên trong.
 */
function cell(value: string): string {
  const v = value ?? "";
  return /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function ExportSheetButton({
  posts,
  sourceUrl,
  pageId,
  sheetCopiedAt,
  lastScrapedAt,
  selectedIds,
  windowHours = 6,
}: {
  posts: CompetitorPostWithComments[];
  sourceUrl: string;
  pageId: string;
  sheetCopiedAt: string | null;
  lastScrapedAt: string | null;
  /** Dòng đang tick ở bảng. Có tick = copy đúng mấy bài đó, bỏ qua cửa sổ giờ. */
  selectedIds: Set<string>;
  windowHours?: number;
}) {
  const [copied, setCopied] = useState(false);
  const router = useRouter();

  const now = useNow();
  const state = sheetState(sheetCopiedAt, posts[0]?.fb_created_at ?? null, lastScrapedAt, now);

  // Có tick dòng nào không? Quyết định luôn cả tập bài lẫn nhãn nút.
  const bySelection = selectedIds.size > 0;

  const rows = useMemo(() => {
    // Chọn tay thì lấy ĐÚNG mấy bài đó, không lọc theo giờ nữa: đã chủ động chọn nghĩa là
    // biết mình lấy gì, kể cả bài cũ hơn cửa sổ.
    // Giữ nguyên thứ tự của bảng (mới nhất trước) chứ không theo thứ tự bấm chuột.
    if (bySelection) return posts.filter((p) => selectedIds.has(p.id));
    // Mặc định: lọc theo GIỜ ĐĂNG chứ không phải giờ cào — "bài trong 6h" tính từ bây giờ.
    // Bài không rõ giờ đăng (fb_created_at null) bị loại — không chứng minh được là bài mới.
    if (now === null) return [];
    const cutoff = now - windowHours * 3600_000;
    return posts.filter((p) => p.fb_created_at && new Date(p.fb_created_at).getTime() >= cutoff);
  }, [posts, windowHours, now, bySelection, selectedIds]);

  async function copy() {
    // Chỉ nội dung, KHÔNG hàng tiêu đề — dán nối tiếp vào sheet có sẵn không bị chen tên cột.
    const tsv = rows
      .map((p) => {
        // Chỉ comment của page (giống cột "Part 2" trên bảng) — DB giờ lưu cả comment người ngoài.
        const part2 = p.comments
          .filter((c) => c.is_page_author)
          .map((c) => (c.message ?? "").trim())
          .filter(Boolean)
          .join("\n\n");
        // MỌI link, không chỉ cái đầu. Vẫn gói trong 1 ô để giữ đúng 5 cột — thêm cột sẽ lệch
        // sheet người dùng đang dán vào.
        const link = collectPostLinks(p).join(" | ");
        return [sourceUrl, p.permalink ?? "", p.caption ?? "", part2, link].map(cell).join("\t");
      })
      .join("\n");

    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      toast.success(
        bySelection
          ? `Đã copy ${rows.length} bài đã chọn — dán vào Sheet (Ctrl+V)`
          : `Đã copy ${rows.length} bài — dán vào Sheet (Ctrl+V)`,
      );
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Không sao chép được — kiểm tra quyền clipboard của trình duyệt");
      return; // clipboard hỏng thì ĐỪNG đánh dấu đã copy, không thì dấu nói dối
    }

    // Copy tay vài bài KHÔNG đánh dấu "đã copy": dấu đó nói về nhịp copy cả page trong ngày
    // (sheetState so với bài mới nhất). Copy 2 bài lẻ mà đóng dấu cả page là dấu nói dối,
    // và lần copy định kỳ sau sẽ bị tưởng là đã xong.
    if (bySelection) return;

    // Ghi mốc đã copy. Hỏng bước này chỉ mất cái nhãn, text đã nằm trong clipboard rồi
    // nên chỉ cảnh báo nhẹ chứ không báo đỏ như thất bại.
    try {
      const { res } = await fetchJson(`/api/competitors/${pageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetCopied: true }),
      });
      if (res.ok) router.refresh();
      else toast.warning("Đã copy nhưng chưa lưu được dấu 'đã copy'");
    } catch {
      toast.warning("Đã copy nhưng chưa lưu được dấu 'đã copy'");
    }
  }

  const none = rows.length === 0;

  return (
    <div className="flex items-center gap-2">
      <SheetStateBadge state={state} copiedAt={sheetCopiedAt} />
      <button
        onClick={copy}
        disabled={none}
        title={
          none
            ? `Không có bài nào đăng trong ${windowHours}h qua (tính từ bây giờ). Tick chọn dòng để copy bài bất kỳ.`
            : bySelection
              ? `Copy ${rows.length} bài đang tick × ${COLUMN_COUNT} cột. Copy tay không đánh dấu "đã copy" cho page.`
              : `Copy ${rows.length} bài × ${COLUMN_COUNT} cột (không có hàng tiêu đề), dán thẳng vào Google Sheet`
        }
        className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs font-medium transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {copied ? <Check className="size-3.5 text-green-600" /> : <Table2 className="size-3.5" />}
        {bySelection
          ? `Copy ${rows.length} bài đã chọn`
          : `Copy bảng cho Sheet (${now === null ? "…" : `${rows.length} bài ≤${windowHours}h`})`}
      </button>
    </div>
  );
}
