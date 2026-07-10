import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { listPages, listPostsWithCommentStatus } from "@/lib/queries";
import { startOfTodayVNISO, startOfDayVNISO, endOfDayVNISO } from "@/lib/date";
import { Button } from "@/components/ui/button";
import { SyncAllButton } from "../_components/sync-all-button";
import { PostsFilters, type PostsSP } from "../_components/posts-filters";
import { PostsTable } from "../_components/posts-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 10;

// Tính khoảng thời gian (ISO) từ searchParams. Mặc định = hôm nay.
function dateFilter(sp: PostsSP): { from?: string; to?: string } {
  if (sp.from || sp.to) {
    return {
      from: sp.from ? startOfDayVNISO(sp.from) : undefined,
      to: sp.to ? endOfDayVNISO(sp.to) : undefined,
    };
  }
  const range = sp.range || "today";
  if (range === "all") return {};
  const todayStart = startOfTodayVNISO();
  const startMs = Date.parse(todayStart);
  const to = new Date(startMs + 24 * 3600 * 1000 - 1).toISOString(); // cuối hôm nay
  if (range === "7d") return { from: new Date(startMs - 6 * 86400000).toISOString(), to };
  if (range === "30d") return { from: new Date(startMs - 29 * 86400000).toISOString(), to };
  return { from: todayStart, to };
}

function buildHref(sp: PostsSP, patch: Partial<PostsSP>): string {
  const merged: PostsSP = { ...sp, ...patch };
  const params = new URLSearchParams();
  if (merged.page) params.set("page", merged.page);
  if (merged.status) params.set("status", merged.status);
  if (merged.range) params.set("range", merged.range);
  if (merged.from) params.set("from", merged.from);
  if (merged.to) params.set("to", merged.to);
  if (merged.uncommented) params.set("uncommented", "1");
  if (merged.p) params.set("p", merged.p);
  const qs = params.toString();
  return qs ? `/posts?${qs}` : "/posts";
}

export default async function PostsPage({ searchParams }: { searchParams: Promise<PostsSP> }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.p) || 1);
  const { from, to } = dateFilter(sp);

  const filter = {
    pageId: sp.page || undefined,
    status: sp.status === "published" ? ("PUBLISHED" as const) : sp.status === "scheduled" ? ("SCHEDULED" as const) : undefined,
    from,
    to,
    uncommented: sp.uncommented === "1",
    page,
    pageSize: PAGE_SIZE,
  };

  const [pages, result] = await Promise.all([listPages(), listPostsWithCommentStatus(filter)]);
  const pageName = Object.fromEntries(pages.map((p) => [p.page_id, p.name]));
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const from1 = result.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to1 = Math.min(page * PAGE_SIZE, result.total);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Bài post</h1>
        <SyncAllButton />
      </div>

      <PostsFilters sp={sp} pages={pages.map((p) => ({ page_id: p.page_id, name: p.name }))} />

      <PostsTable posts={result.rows} pageName={pageName} />

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
