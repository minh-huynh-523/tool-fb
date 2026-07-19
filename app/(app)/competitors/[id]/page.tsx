import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCompetitorPageWithPosts } from "@/lib/queries";
import { formatVN } from "@/lib/date";
import { CompetitorActions } from "../../_components/competitor-actions";
import { CompetitorPostsTable } from "../../_components/competitor-posts-table";

export const dynamic = "force-dynamic";

export default async function CompetitorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getCompetitorPageWithPosts(id);
  if (!detail) notFound();
  const { page, posts } = detail;

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
              {posts.length} bài
            </div>
          </div>
        </div>
        <CompetitorActions id={page.id} active={page.active} compact />
      </div>

      {posts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 p-10 text-center text-neutral-400 dark:border-neutral-700">
          Chưa cào được bài nào. Bấm <b>Cào ngay</b> (worker ở laptop cần đang chạy).
        </div>
      ) : (
        <CompetitorPostsTable
          posts={posts}
          pageHandle={page.handle}
          pageId={page.id}
          sheetCopiedAt={page.sheet_copied_at}
        />
      )}
    </div>
  );
}
