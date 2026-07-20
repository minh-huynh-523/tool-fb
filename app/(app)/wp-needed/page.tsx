import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { envThresholds, listPages, listPostsWithCommentStatus } from "@/lib/queries";
import { clampThresholds, thresholdLabel } from "@/lib/attention";
import { startOfTodayVNISO, startOfDayVNISO, endOfDayVNISO } from "@/lib/date";
import { Button } from "@/components/ui/button";
import { SyncAllButton } from "../_components/sync-all-button";
import { PostsTable } from "../_components/posts-table";
import { WpNeededFilters, type WpNeededSP } from "../_components/wp-needed-filters";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 10;

// Khoảng ngày ĐĂNG BÀI (display_time). Mặc định 'all' — khác /posts (mặc định hôm nay): hàng đợi
// việc còn tồn không được tự giấu bài cũ, lọc ngày chỉ để thu hẹp khi danh sách dài.
function dateFilter(sp: WpNeededSP): { from?: string; to?: string } {
  if (sp.from || sp.to) {
    return {
      from: sp.from ? startOfDayVNISO(sp.from) : undefined,
      to: sp.to ? endOfDayVNISO(sp.to) : undefined,
    };
  }
  const range = sp.range || "all";
  if (range === "all") return {};
  const todayStart = startOfTodayVNISO();
  const startMs = Date.parse(todayStart);
  const to = new Date(startMs + 24 * 3600 * 1000 - 1).toISOString(); // cuối hôm nay
  if (range === "7d") return { from: new Date(startMs - 6 * 86400000).toISOString(), to };
  if (range === "30d") return { from: new Date(startMs - 29 * 86400000).toISOString(), to };
  return { from: todayStart, to };
}

function buildHref(sp: WpNeededSP, patch: Partial<WpNeededSP>): string {
  const merged: WpNeededSP = { ...sp, ...patch };
  const params = new URLSearchParams();
  if (merged.page) params.set("page", merged.page);
  if (merged.range) params.set("range", merged.range);
  if (merged.from) params.set("from", merged.from);
  if (merged.to) params.set("to", merged.to);
  if (merged.r) params.set("r", merged.r);
  if (merged.c) params.set("c", merged.c);
  if (merged.show) params.set("show", merged.show);
  if (merged.p) params.set("p", merged.p);
  const qs = params.toString();
  return qs ? `/wp-needed?${qs}` : "/wp-needed";
}

// Hàng đợi: bài ĐÃ ĐĂNG, đang có tương tác, mà CHƯA có bài WordPress nào.
// Không có bộ lọc ngày ở đây — một hàng đợi mà giấu bớt việc theo ngày thì tự phá mục đích.
export default async function WpNeededPage({ searchParams }: { searchParams: Promise<WpNeededSP> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.p) || 1);

  // Ngưỡng env là nguồn sự thật (badge dùng nó); ?r=&c= chỉ để xem thử trên trang này.
  const env = envThresholds();
  const t = clampThresholds(sp.r ?? env.minReactions, sp.c ?? env.minComments);
  const custom = t.minReactions !== env.minReactions || t.minComments !== env.minComments;
  const dismissedView = sp.show === "dismissed";
  const { from, to } = dateFilter(sp);

  const [pages, result] = await Promise.all([
    listPages(),
    listPostsWithCommentStatus({
      pageId: sp.page || undefined,
      from,
      to,
      needsWp: { ...t, dismissedOnly: dismissedView },
      page,
      pageSize: PAGE_SIZE,
    }),
  ]);
  const pageName = Object.fromEntries(pages.map((p) => [p.page_id, p.name]));
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const from1 = result.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to1 = Math.min(page * PAGE_SIZE, result.total);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Cần đăng link WP</h1>
        <SyncAllButton />
      </div>

      <p className="text-sm text-muted-foreground">
        Bài đã lên sóng, đang có tương tác nhưng <strong>chưa có bài WordPress nào</strong>. Ngưỡng hiện tại:{" "}
        <strong>{thresholdLabel(t)}</strong>. Số comment tính cả comment của chính page, nên thực tế ngưỡng comment
        tương đương {Math.max(0, t.minComments - 1)} comment của người ngoài.
        {custom && " Đang xem ngưỡng tuỳ chỉnh — badge ở sidebar vẫn đếm theo ngưỡng mặc định."}
      </p>

      <WpNeededFilters
        sp={sp}
        pages={pages.map((p) => ({ page_id: p.page_id, name: p.name }))}
        thresholds={t}
        custom={custom}
      />

      <PostsTable
        posts={result.rows}
        pageName={pageName}
        showEngagement
        dismissable
        emptyMessage={
          dismissedView
            ? "Chưa bỏ qua bài nào."
            : from || to
              ? "Không có bài nào trong khoảng ngày này — thử mở rộng sang “Tất cả”."
              : "Không có bài nào đang chờ — mọi bài đủ tương tác đều đã có bài WP."
        }
      />

      {/* Phân trang */}
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
