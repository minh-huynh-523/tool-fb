import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { getCompetitorPageWithPosts } from "@/lib/queries";
import { formatVN } from "@/lib/date";
import { Button } from "@/components/ui/button";
import { CompetitorActions } from "../../_components/competitor-actions";
import { CompetitorPostsTable } from "../../_components/competitor-posts-table";

export const dynamic = "force-dynamic";

interface SP {
  p?: string;
}

export default async function CompetitorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const pageNum = Math.max(1, Number(sp.p) || 1);

  const detail = await getCompetitorPageWithPosts(id, { page: pageNum });
  if (!detail) notFound();
  const { page, posts, total, newestPostAt, pageSize } = detail;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from1 = total === 0 ? 0 : (pageNum - 1) * pageSize + 1;
  const to1 = Math.min(pageNum * pageSize, total);
  const hrefFor = (p: number) => (p <= 1 ? `/competitors/${id}` : `/competitors/${id}?p=${p}`);

  return (
    <div className="space-y-6">
      <Link href="/competitors" className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-foreground">
        <ArrowLeft className="size-4" /> Đối thủ
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {page.picture && <img src={page.picture} alt="" className="h-11 w-11 rounded-full" />}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{page.name ?? page.handle}</h1>
              {page.genre && (
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                  {page.genre}
                </span>
              )}
            </div>
            <div className="text-xs text-neutral-500">
              <span className="font-mono">{page.handle}</span>
              {" · "}
              {page.last_scraped_at ? `cào lần cuối ${formatVN(page.last_scraped_at)}` : "chưa cào"}
              {page.last_error && <span className="text-red-600"> · lỗi: {page.last_error}</span>}
              {" · "}
              {total} bài
            </div>
          </div>
        </div>
        <CompetitorActions id={page.id} active={page.active} compact />
      </div>

      {total === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 p-10 text-center text-neutral-400 dark:border-neutral-700">
          Chưa cào được bài nào. Bấm <b>Cào ngay</b> (worker ở laptop cần đang chạy).
        </div>
      ) : (
        <>
          <CompetitorPostsTable
            posts={posts}
            pageHandle={page.handle}
            pageId={page.id}
            sheetCopiedAt={page.sheet_copied_at}
            lastScrapedAt={page.last_scraped_at}
            newestPostAt={newestPostAt}
          />

          {/* Bảng chỉ hiện MỘT trang bài. Chọn/copy sang Sheet vì thế cũng chỉ tính trong trang
              đang xem — không phải vấn đề trong thực tế vì nút copy mặc định chỉ lấy bài trong 6
              giờ gần nhất (xem ExportSheetButton), tức luôn nằm ở trang 1. */}
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {from1}–{to1} / {total} bài
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={pageNum <= 1} asChild={pageNum > 1}>
                  {pageNum > 1 ? (
                    <Link href={hrefFor(pageNum - 1)}>
                      <ChevronLeft /> Trước
                    </Link>
                  ) : (
                    <span>
                      <ChevronLeft /> Trước
                    </span>
                  )}
                </Button>
                <span className="px-1">
                  Trang {pageNum}/{totalPages}
                </span>
                <Button variant="outline" size="sm" disabled={pageNum >= totalPages} asChild={pageNum < totalPages}>
                  {pageNum < totalPages ? (
                    <Link href={hrefFor(pageNum + 1)}>
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
        </>
      )}
    </div>
  );
}
