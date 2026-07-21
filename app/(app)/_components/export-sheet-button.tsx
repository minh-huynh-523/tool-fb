"use client";

import { useMemo, useState } from "react";
import { Check, Table2 } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { collectPostLinks } from "@/lib/fb-link";
import { fetchJson } from "@/lib/fetch-json";
import { useNow } from "@/lib/use-now";
import { sheetState } from "@/lib/sheet-state";
import { pickSheetRows } from "@/lib/sheet-rows";
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

  const rows = useMemo(
    () => pickSheetRows(posts, selectedIds, windowHours, now),
    [posts, selectedIds, windowHours, now],
  );

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

    // Đánh dấu TỪNG BÀI đã copy — đây là thứ khiến lần copy sau không lấy lại chúng.
    // Chạy cho CẢ hai chế độ: copy tay cũng là đã copy.
    // Hỏng bước này chỉ mất cái dấu, text đã nằm trong clipboard rồi nên chỉ cảnh báo nhẹ.
    let marked = false;
    try {
      const { res } = await fetchJson(`/api/competitors/${pageId}/mark-copied`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postIds: rows.map((p) => p.id) }),
      });
      marked = res.ok;
    } catch {
      marked = false;
    }
    if (!marked) {
      toast.warning("Đã copy nhưng CHƯA đánh dấu được — lần sau có thể bị lấy trùng mấy bài này");
    }

    // Mốc ở cấp PAGE (badge nhịp làm việc trong ngày) chỉ đóng cho lượt copy định kỳ.
    // Copy tay vài bài mà đóng dấu cả page là dấu nói dối: lượt copy định kỳ sau sẽ bị
    // tưởng là đã xong.
    if (!bySelection) {
      try {
        await fetchJson(`/api/competitors/${pageId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sheetCopied: true }),
        });
      } catch {
        // Dấu cấp page hỏng không đáng bắn thêm toast thứ hai — dấu từng bài mới là thứ quan trọng.
      }
    }

    // refresh() để bảng vẽ lại trạng thái "đã copy" và nút tính lại số bài còn phải copy.
    router.refresh();
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
            ? `Không còn bài nào CHƯA copy trong ${windowHours}h qua. Tick chọn dòng để copy lại bài bất kỳ.`
            : bySelection
              ? `Copy ${rows.length} bài đang tick × ${COLUMN_COUNT} cột — kể cả bài đã copy rồi.`
              : `Copy ${rows.length} bài chưa copy, đăng trong ${windowHours}h qua × ${COLUMN_COUNT} cột (không hàng tiêu đề)`
        }
        className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs font-medium transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        {copied ? <Check className="size-3.5 text-green-600" /> : <Table2 className="size-3.5" />}
        {bySelection
          ? `Copy ${rows.length} bài đã chọn`
          : `Copy bảng cho Sheet (${now === null ? "…" : `${rows.length} bài mới ≤${windowHours}h`})`}
      </button>
    </div>
  );
}
