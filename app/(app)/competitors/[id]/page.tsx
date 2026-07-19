import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { getCompetitorPageWithPosts } from "@/lib/queries";
import { formatVN } from "@/lib/date";
import { CompetitorActions } from "../../_components/competitor-actions";
import { CopyButton } from "../../_components/copy-button";

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
            <h1 className="text-xl font-semibold">{page.name ?? page.handle}</h1>
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
        <div className="overflow-x-auto rounded-2xl border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-neutral-100 text-left text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th className="w-28 px-4 py-2 font-medium">Bài</th>
                <th className="w-[40%] px-4 py-2 font-medium">Caption FB</th>
                <th className="px-4 py-2 font-medium">Comment của page (Part 2 + link)</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id} className="border-t border-neutral-200 align-top dark:border-neutral-800">
                  {/* Bài: ảnh + thời gian + link gốc */}
                  <td className="px-4 py-3">
                    {post.media_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={post.media_url} alt="" className="mb-1.5 h-16 w-16 rounded-lg object-cover" />
                    )}
                    <div className="text-xs text-neutral-400">{post.fb_created_at ? formatVN(post.fb_created_at) : "—"}</div>
                    {post.permalink && (
                      <a href={post.permalink} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-foreground">
                        <ExternalLink className="size-3" /> bài gốc
                      </a>
                    )}
                  </td>

                  {/* Caption + nút copy */}
                  <td className="px-4 py-3">
                    {post.caption ? (
                      <div className="space-y-1.5">
                        <div className="flex justify-end">
                          <CopyButton text={post.caption} label="Copy caption" />
                        </div>
                        <p className="whitespace-pre-wrap break-words text-neutral-800 dark:text-neutral-200">{post.caption}</p>
                      </div>
                    ) : (
                      <span className="text-neutral-400">(không có caption)</span>
                    )}
                  </td>

                  {/* Comment của page: mỗi comment 1 khối, có copy text + copy link */}
                  <td className="px-4 py-3">
                    {post.comments.length === 0 ? (
                      <span className="text-neutral-400">(chưa có comment của page)</span>
                    ) : (
                      <div className="space-y-3">
                        {post.comments.map((c) => (
                          <div key={c.id} className="space-y-1.5">
                            <div className="flex items-center justify-end gap-1.5">
                              {c.message && <CopyButton text={c.message} label="Copy comment" />}
                              {c.link_url && <CopyButton text={c.link_url} label="Copy link" title={c.link_url} />}
                            </div>
                            {c.message && (
                              <p className="whitespace-pre-wrap break-words text-neutral-800 dark:text-neutral-200">{c.message}</p>
                            )}
                            {c.link_url && (
                              <a href={c.link_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-xs text-blue-600 hover:underline">
                                <ExternalLink className="size-3 shrink-0" /> {c.link_url}
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
