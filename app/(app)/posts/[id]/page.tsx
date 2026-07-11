import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink, Clock } from "lucide-react";
import { getPostWithComments, getLivePostComments } from "@/lib/queries";
import { formatVN } from "@/lib/date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "../../_components/status-badge";
import { AddCommentForm } from "../../_components/add-comment-form";
import { DeleteCommentButton } from "../../_components/delete-comment-button";
import { EditCommentButton } from "../../_components/edit-comment-button";
import { CollapsibleText } from "../../_components/collapsible-text";
import { WordpressPostButton } from "../../_components/wordpress-post-button";

export const dynamic = "force-dynamic";

export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getPostWithComments(id);
  if (!data) notFound();
  const { post, comments, scraped } = data;
  // Comment thật trên FB (chỉ với bài đã đăng — bài lên lịch chưa có comment).
  const live = post.is_published ? await getLivePostComments(post.fb_post_id, post.page_id) : null;

  return (
    <div className="space-y-5">
      <Link href="/posts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="size-4" /> Về danh sách
      </Link>

      {/* Post content */}
      <Card>
        <CardContent className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge
                className={
                  post.is_published
                    ? "border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
                    : "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                }
              >
                {post.is_published ? "Đã đăng" : "Lên lịch"}
              </Badge>
              <span>{post.media_type ?? "post"}</span>
              <span>·</span>
              <span>{formatVN(post.display_time ?? post.fb_created_at)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <WordpressPostButton
                postDbId={post.id}
                existing={
                  scraped
                    ? { editUrl: scraped.wp_edit_url, status: scraped.wp_status, permalink: scraped.wp_permalink }
                    : null
                }
                commentsInfo={{
                  // comments sort theo created_at DESC -> lấy min run_after làm first comment
                  firstRunAfter: comments.length
                    ? comments.reduce((min, c) => (c.run_after < min ? c.run_after : min), comments[0].run_after)
                    : null,
                  texts: comments.map((c) => `${c.message ?? ""} ${c.attachment_url ?? ""}`),
                }}
              />
              {post.permalink && (
                <Button variant="outline" size="sm" asChild>
                  <a href={post.permalink} target="_blank" rel="noopener noreferrer">
                    <ExternalLink /> Xem trên FB
                  </a>
                </Button>
              )}
            </div>
          </div>
          {post.media_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.media_url} alt="" className="max-h-80 rounded-lg object-contain" />
          )}
          {post.message ? (
            <CollapsibleText text={post.message} />
          ) : (
            <p className="text-muted-foreground">(không có nội dung)</p>
          )}
          <p className="font-mono text-xs text-muted-foreground">{post.fb_post_id}</p>
        </CardContent>
      </Card>

      {/* Comment THẬT trên Facebook */}
      {live && (
        <div>
          <h2 className="mb-2 flex items-center gap-2 font-medium">
            Comment trên Facebook
            <Badge variant="secondary">{live.total}</Badge>
            {post.page_commented ? (
              <Badge className="border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300">
                Page đã comment
              </Badge>
            ) : (
              <Badge className="border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300">
                Page chưa comment
              </Badge>
            )}
          </h2>
          {live.comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Bài chưa có comment nào trên Facebook.</p>
          ) : (
            <ul className="space-y-2">
              {live.comments.map((c) => {
                const isPage = c.from?.id === live.pageId;
                return (
                  <Card key={c.id} className={isPage ? "border-blue-300 dark:border-blue-800" : ""}>
                    <CardContent className="space-y-1 text-sm">
                      <div className="flex items-center gap-2">
                        {c.from?.picture?.data?.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.from.picture.data.url} alt="" className="size-5 rounded-full" />
                        ) : null}
                        <span className="font-medium">{c.from?.name ?? "Ẩn danh"}</span>
                        {isPage && (
                          <Badge className="border-transparent bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                            Page
                          </Badge>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground">{formatVN(c.created_time ?? null)}</span>
                      </div>
                      {c.message && <CollapsibleText text={c.message} />}
                    </CardContent>
                  </Card>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <AddCommentForm postDbId={post.id} />

      {/* Comment mình đã lên lịch (hàng đợi nội bộ) */}
      <div>
        <h2 className="mb-2 font-medium">Comment mình đã lên lịch (hàng đợi)</h2>
        {comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có comment nào.</p>
        ) : (
          <ul className="space-y-2">
            {comments.map((c) => {
              const scheduledAhead = c.status === "PENDING";
              return (
                <Card key={c.id}>
                  <CardContent className="space-y-1 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge status={c.status} />
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground">{formatVN(c.created_at)}</span>
                        <EditCommentButton
                          postDbId={post.id}
                          comment={{
                            id: c.id,
                            message: c.message,
                            attachment_url: c.attachment_url,
                            run_after: c.run_after,
                            status: c.status,
                          }}
                        />
                        <DeleteCommentButton
                          postDbId={post.id}
                          comment={{ id: c.id, message: c.message, status: c.status }}
                        />
                      </div>
                    </div>
                    {scheduledAhead && (
                      <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                        <Clock className="size-3" /> Hẹn đăng: {formatVN(c.run_after)}
                      </p>
                    )}
                    {c.message && <CollapsibleText text={c.message} />}
                    {c.attachment_url && (
                      <a
                        href={c.attachment_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline"
                      >
                        {c.attachment_url}
                      </a>
                    )}
                    {c.status === "FAILED" && c.error && <p className="text-xs text-red-600">{c.error}</p>}
                  </CardContent>
                </Card>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
