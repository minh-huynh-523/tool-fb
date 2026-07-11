"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { Check, Clock, ExternalLink, MessageSquarePlus, X } from "lucide-react";
import { formatVN } from "@/lib/date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AddCommentForm } from "./add-comment-form";
import { CollapsibleText } from "./collapsible-text";
import { DeleteCommentButton } from "./delete-comment-button";
import { EditCommentButton } from "./edit-comment-button";
import { StatusBadge } from "./status-badge";
import { WordpressPostButton } from "./wordpress-post-button";
import type { CommentHistoryRow, CommentStatus, PostRow } from "@/lib/types";

type Row = PostRow & {
  commentStatus: CommentStatus | null;
  commentCounts: Partial<Record<CommentStatus, number>>;
  comments: CommentHistoryRow[];
  wp: {
    wp_post_id: string | null;
    wp_edit_url: string | null;
    wp_status: string | null;
    wp_permalink: string | null;
  } | null;
};

function TypeBadge({ published }: { published: boolean }) {
  return (
    <Badge
      className={
        published
          ? "border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300"
          : "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
      }
    >
      {published ? "Đã đăng" : "Lên lịch"}
    </Badge>
  );
}

export function PostsTable({ posts, pageName }: { posts: Row[]; pageName: Record<string, string> }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Bài post</TableHead>
            <TableHead className="hidden sm:table-cell">Page</TableHead>
            <TableHead className="hidden md:table-cell">Thời gian</TableHead>
            <TableHead>Comment</TableHead>
            <TableHead className="text-right"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {posts.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                Không có bài post. Bấm “Đồng bộ tất cả page” để kéo về.
              </TableCell>
            </TableRow>
          )}
          {posts.map((p) => {
            const isOpen = openId === p.id;
            return (
              <Fragment key={p.id}>
                {/* Click vào row là mở/đóng phần comment luôn — trừ khi click vào link/nút/form bên trong. */}
                <TableRow
                  className="cursor-pointer align-top"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a,button,input,textarea,select,[role='dialog']")) return;
                    setOpenId(isOpen ? null : p.id);
                  }}
                >
                  <TableCell>
                    <div className="flex gap-3">
                      {p.media_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.media_url} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                      ) : (
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
                          {p.media_type ?? "text"}
                        </div>
                      )}
                      <div className="min-w-0 space-y-1">
                        <p className="line-clamp-1 max-w-56 text-foreground/80">
                          {p.message || <span className="text-muted-foreground">(không có nội dung)</span>}
                        </p>
                        <div className="sm:hidden">
                          <TypeBadge published={p.is_published} />
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    <div className="space-y-1">
                      <div>{pageName[p.page_id] ?? p.page_id}</div>
                      <TypeBadge published={p.is_published} />
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {formatVN(p.display_time ?? p.fb_created_at)}
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      {p.page_commented ? (
                        <Badge className="border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300">
                          <Check className="size-3" /> Đã comment
                          {p.comment_count ? ` (${p.comment_count})` : ""}
                        </Badge>
                      ) : (
                        <Badge className="border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300">
                          Chưa comment
                        </Badge>
                      )}
                      {(p.commentStatus === "PENDING" || p.commentStatus === "PROCESSING") && (
                        <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                          <Clock className="size-3" /> Đã lên lịch
                        </div>
                      )}
                      {p.commentStatus === "FAILED" && (
                        <div className="text-xs text-red-600">Gửi lỗi — thử lại</div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {p.permalink && (
                        <Button variant="outline" size="sm" asChild>
                          <a href={p.permalink} target="_blank" rel="noopener noreferrer">
                            <ExternalLink /> FB
                          </a>
                        </Button>
                      )}
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/posts/${p.id}`}>Chi tiết</Link>
                      </Button>
                      <WordpressPostButton
                        postDbId={p.id}
                        existing={
                          p.wp
                            ? { editUrl: p.wp.wp_edit_url, status: p.wp.wp_status, permalink: p.wp.wp_permalink }
                            : null
                        }
                        commentsInfo={{
                          // p.comments đã sort run_after ASC -> phần tử đầu là first comment
                          firstRunAfter: p.comments[0]?.run_after ?? null,
                          texts: p.comments.map((c) => `${c.message ?? ""} ${c.attachment_url ?? ""}`),
                        }}
                      />
                      <Button size="sm" onClick={() => setOpenId(isOpen ? null : p.id)}>
                        {isOpen ? <X /> : <MessageSquarePlus />}
                        {isOpen ? "Đóng" : "Comment"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={5}>
                      <div className="space-y-4">
                        {/* Lịch sử comment của mình đã lên lịch cho bài này + trạng thái */}
                        <div>
                          <h3 className="mb-2 text-sm font-medium">
                            Comment đã lên lịch{p.comments.length ? ` (${p.comments.length})` : ""}
                          </h3>
                          {p.comments.length === 0 ? (
                            <p className="text-sm text-muted-foreground">Chưa lên lịch comment nào cho bài này.</p>
                          ) : (
                            <div className="overflow-hidden rounded-lg border bg-background">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Nội dung</TableHead>
                                    <TableHead className="w-44">Hẹn đăng</TableHead>
                                    <TableHead className="w-36">Trạng thái</TableHead>
                                    <TableHead className="w-52">Kết quả</TableHead>
                                    <TableHead className="w-28"></TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {p.comments.map((c) => (
                                    <TableRow key={c.id}>
                                      <TableCell className="max-w-xs align-top">
                                        {c.message ? (
                                          <CollapsibleText text={c.message} />
                                        ) : (
                                          <p className="text-muted-foreground">(chỉ đính kèm link)</p>
                                        )}
                                        {c.attachment_url && (
                                          <a
                                            href={c.attachment_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="line-clamp-1 break-all text-xs text-blue-600 hover:underline"
                                          >
                                            {c.attachment_url}
                                          </a>
                                        )}
                                      </TableCell>
                                      <TableCell className="align-top text-sm text-muted-foreground">
                                        {formatVN(c.run_after)}
                                      </TableCell>
                                      <TableCell className="align-top">
                                        <StatusBadge status={c.status} />
                                      </TableCell>
                                      <TableCell className="align-top text-xs text-muted-foreground">
                                        {c.status === "SENT" && c.sent_at ? (
                                          `Đã đăng ${formatVN(c.sent_at)}`
                                        ) : c.status === "FAILED" ? (
                                          <span className="text-red-600">{c.error || "Gửi lỗi"}</span>
                                        ) : (
                                          "—"
                                        )}
                                      </TableCell>
                                      <TableCell className="align-top">
                                        <div className="flex items-center">
                                          <EditCommentButton
                                            postDbId={p.id}
                                            comment={{
                                              id: c.id,
                                              message: c.message,
                                              attachment_url: c.attachment_url,
                                              run_after: c.run_after,
                                              status: c.status,
                                            }}
                                          />
                                          <DeleteCommentButton
                                            postDbId={p.id}
                                            comment={{ id: c.id, message: c.message, status: c.status }}
                                          />
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>
                          )}
                        </div>

                        {/* Thêm comment mới (không đóng dòng — thêm xong hiện ngay ở bảng trên) */}
                        <div className="max-w-2xl">
                          {!p.is_published && (
                            <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
                              Bài đang lên lịch — comment sẽ tự đăng sau khi bài lên sóng
                              {p.scheduled_publish_time ? ` (${formatVN(p.scheduled_publish_time)})` : ""}.
                            </p>
                          )}
                          <AddCommentForm postDbId={p.id} compact onClose={() => setOpenId(null)} />
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
