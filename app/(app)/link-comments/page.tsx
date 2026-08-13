import Link from "next/link";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { listAutoPublishQueue, listPages } from "@/lib/queries";
import { formatVN } from "@/lib/date";
import { Button } from "@/components/ui/button";
import { AutoPublishBadge } from "../_components/auto-publish-badge";
import { RetryAutoPublishButton } from "../_components/retry-auto-publish-button";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const STATUS_TABS: { value: string; label: string }[] = [
  { value: "", label: "Tất cả" },
  { value: "PENDING", label: "Chờ" },
  { value: "PROCESSING", label: "Đang xử lý" },
  { value: "PUBLISHED", label: "Đã đăng WP" },
  { value: "FAILED", label: "Lỗi" },
];

const STAGE_LABEL: Record<string, string> = {
  content: "Sinh nội dung (Gemini)",
  publish: "Đăng WordPress",
};

interface SP {
  status?: string;
  p?: string;
}

function buildHref(sp: SP, patch: Partial<SP>): string {
  const merged: SP = { ...sp, ...patch };
  const params = new URLSearchParams();
  if (merged.status) params.set("status", merged.status);
  if (merged.p) params.set("p", merged.p);
  const qs = params.toString();
  return qs ? `/link-comments?${qs}` : "/link-comments";
}

// Trang riêng theo dõi hàng đợi auto-publish (lib/auto-publish.ts, migration 0024): bài nào đang
// chờ/đang sinh bài WP qua Gemini (wp_content_queue), bài nào đang chờ/đã đăng thật lên WordPress
// (wp_publish_queue), bài nào lỗi. Badge auto-publish ở /posts phải mở từng bài mới thấy — trang
// này thấy hết trạng thái của cả hàng đợi trong 1 bảng, bấm "Thử lại" được luôn khi lỗi.
export default async function AutoPublishQueuePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.p) || 1);
  const status = sp.status || undefined;

  const [pages, result] = await Promise.all([
    listPages(),
    listAutoPublishQueue({ status, page, pageSize: PAGE_SIZE }),
  ]);
  const pageName = Object.fromEntries(pages.map((p) => [p.page_id, p.name]));
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const from1 = result.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to1 = Math.min(page * PAGE_SIZE, result.total);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Auto-publish WP</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Bài đủ ngưỡng được tự động đưa vào hàng đợi để Gemini sinh bài WP rồi tự đăng lên WordPress — theo dõi
          trạng thái từng bước ở đây, không cần mở từng bài.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_TABS.map((t) => (
          <Button key={t.value} variant={(sp.status ?? "") === t.value ? "default" : "outline"} size="sm" asChild>
            <Link href={buildHref(sp, { status: t.value || undefined, p: undefined })}>{t.label}</Link>
          </Button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-muted-foreground">
              <th className="px-4 py-2 font-medium">Bài</th>
              <th className="px-4 py-2 font-medium">Page</th>
              <th className="px-4 py-2 font-medium">Giai đoạn</th>
              <th className="px-4 py-2 font-medium">Trạng thái</th>
              <th className="px-4 py-2 font-medium">Kết quả</th>
              <th className="px-4 py-2 font-medium">Vào hàng đợi</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-muted-foreground">
                  Chưa có bài nào trong hàng đợi auto-publish.
                </td>
              </tr>
            )}
            {result.rows.map((r) => (
              <tr key={r.postId} className="border-t align-top">
                <td className="max-w-56 px-4 py-3">
                  {r.post ? (
                    <div className="flex gap-2">
                      {r.post.media_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.post.media_url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                      ) : null}
                      <Link href={`/posts/${r.post.id}`} className="line-clamp-2 hover:underline">
                        {r.post.message || "(không có nội dung)"}
                      </Link>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">(bài đã bị xoá)</span>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {r.post ? (pageName[r.post.page_id] ?? r.post.page_id) : "—"}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{STAGE_LABEL[r.stage] ?? r.stage}</td>
                <td className="px-4 py-3">
                  <AutoPublishBadge autoPublish={r} />
                </td>
                <td className="max-w-xs px-4 py-3 text-xs text-muted-foreground">
                  {r.status === "PUBLISHED" && r.permalink ? (
                    <a
                      href={r.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                    >
                      Xem bài WP <ExternalLink className="size-3" />
                    </a>
                  ) : r.status === "FAILED" ? (
                    <span className="text-red-600">{r.error || "Lỗi"}</span>
                  ) : r.status === "PENDING" && r.attempts > 0 ? (
                    <span className="text-orange-600">{r.error || "Lượt trước hỏng"}</span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{formatVN(r.createdAt)}</td>
                <td className="px-4 py-3">
                  {r.status === "FAILED" && r.post && <RetryAutoPublishButton postDbId={r.post.id} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{result.total === 0 ? "Không có bài" : `${from1}–${to1} / ${result.total} bài`}</span>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} asChild={page > 1}>
              {page > 1 ? (
                <Link href={buildHref(sp, { p: String(page - 1) })}>
                  <ChevronLeft /> Trước
                </Link>
              ) : (
                <span>
                  <ChevronLeft /> Trước
                </span>
              )}
            </Button>
            <span className="px-1">
              Trang {page}/{totalPages}
            </span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} asChild={page < totalPages}>
              {page < totalPages ? (
                <Link href={buildHref(sp, { p: String(page + 1) })}>
                  Sau <ChevronRight />
                </Link>
              ) : (
                <span>
                  Sau <ChevronRight />
                </span>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
