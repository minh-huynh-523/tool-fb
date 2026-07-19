"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatVN } from "@/lib/date";
import type { CompetitorPostWithComments } from "@/lib/queries";
import { CollapsibleText } from "./collapsible-text";
import { CopyButton } from "./copy-button";
import { PromptCell } from "./prompt-cell";
import { useBatchPrompt, type BatchTarget } from "./use-batch-prompt";

// Bảng bài đối thủ. Là client component vì cần state chọn nhiều dòng dùng chung
// (checkbox + "chọn tất cả" + chạy prompt hàng loạt). Page vẫn là server component.

export function CompetitorPostsTable({ posts }: { posts: CompetitorPostWithComments[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overwrite, setOverwrite] = useState(false);
  const { state, run, stop } = useBatchPrompt();

  const allSelected = posts.length > 0 && selected.size === posts.length;
  const someSelected = selected.size > 0 && !allSelected;

  const targets: BatchTarget[] = useMemo(
    () =>
      posts
        .filter((p) => selected.has(p.id))
        .map((p) => ({
          id: p.id,
          hasCaption: !!p.caption?.trim(),
          hasPrompt: !!p.prompt_at && !p.prompt_error,
        })),
    [posts, selected],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(posts.map((p) => p.id)));
  }

  return (
    <div className="space-y-3">
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <span className="font-medium">Đã chọn {selected.size} bài</span>

          {state.running ? (
            <>
              <span className="text-neutral-500">
                Đang chạy {state.done}/{state.total}…
              </span>
              <Button size="sm" variant="outline" onClick={stop}>
                <Square /> Dừng
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => run(targets, overwrite)}>
              <Sparkles /> Tạo prompt cho {selected.size} bài
            </Button>
          )}

          {/* Mặc định TẮT: bấm nhầm "chọn tất cả" không được phép đốt lại tiền cho bài đã xong. */}
          <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              disabled={state.running}
              className="size-3.5"
            />
            Ghi đè bài đã có prompt
          </label>

          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={state.running}>
            Bỏ chọn
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="bg-neutral-100 text-left text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={toggleAll}
                  title="Chọn tất cả"
                  className="size-4"
                />
              </th>
              <th className="w-28 px-4 py-2 font-medium">Bài</th>
              <th className="w-[28%] px-4 py-2 font-medium">Caption FB</th>
              <th className="px-4 py-2 font-medium">Comment của page (Part 2 + link)</th>
              <th className="w-[30%] px-4 py-2 font-medium">Prompt</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((post) => {
              const part2 = post.comments
                .map((c) => (c.message ?? "").trim())
                .filter(Boolean)
                .join("\n\n");
              const link = post.comments.find((c) => c.link_url)?.link_url ?? "";
              const allText = [post.caption ?? "", part2, link].filter(Boolean).join("\n\n");

              return (
                <tr key={post.id} className="border-t border-neutral-200 align-top dark:border-neutral-800">
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(post.id)}
                      onChange={() => toggle(post.id)}
                      className="size-4"
                    />
                  </td>

                  {/* Bài: ảnh + thời gian + link gốc */}
                  <td className="px-4 py-3">
                    {post.media_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={post.media_url} alt="" className="mb-1.5 h-16 w-16 rounded-lg object-cover" />
                    )}
                    <div className="text-xs text-neutral-400">
                      {post.fb_created_at ? formatVN(post.fb_created_at) : "—"}
                    </div>
                    {post.permalink && (
                      <a
                        href={post.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-foreground"
                      >
                        <ExternalLink className="size-3" /> bài gốc
                      </a>
                    )}
                    {allText && (
                      <div className="mt-1.5">
                        <CopyButton text={allText} label="Copy tất cả" title="Caption + part 2 + link" />
                      </div>
                    )}
                  </td>

                  {/* Caption + nút copy */}
                  <td className="px-4 py-3">
                    {post.caption ? (
                      <div className="space-y-1.5">
                        <div className="flex justify-end">
                          <CopyButton text={post.caption} label="Copy caption" />
                        </div>
                        <CollapsibleText text={post.caption} />
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
                            {c.message && <CollapsibleText text={c.message} />}
                            {c.link_url && (
                              <a
                                href={c.link_url}
                                target="_blank"
                                rel="noreferrer"
                                title={c.link_url}
                                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                              >
                                <ExternalLink className="size-3 shrink-0" />
                                <span className="line-clamp-1 break-all">{c.link_url}</span>
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>

                  {/* Prompt ảnh + prompt video do Gemini sinh */}
                  <td className="px-4 py-3">
                    <PromptCell
                      // key theo prompt_at: sau router.refresh() (nhất là cuối một lô),
                      // component phải mount lại để nuốt dữ liệu mới thay vì giữ state cũ.
                      key={post.prompt_at ?? "none"}
                      postId={post.id}
                      hasCaption={!!post.caption?.trim()}
                      batchStatus={state.status.get(post.id)}
                      batchError={state.errors.get(post.id)}
                      initial={{
                        storyAnalysis: post.story_analysis,
                        promptImage: post.prompt_image,
                        promptVideo: post.prompt_video,
                        promptModel: post.prompt_model,
                        promptAt: post.prompt_at,
                        promptError: post.prompt_error,
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
