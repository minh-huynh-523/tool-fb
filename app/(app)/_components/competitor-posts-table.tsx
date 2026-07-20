"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatVN, relativeVN } from "@/lib/date";
import { useNow } from "@/lib/use-now";
import { collectPostLinks, competitorPageUrl } from "@/lib/fb-link";
import type { CompetitorPostWithComments } from "@/lib/queries";
import { CollapsibleText } from "./collapsible-text";
import { CopyButton } from "./copy-button";
import { ExportSheetButton } from "./export-sheet-button";
import { PromptCell } from "./prompt-cell";
import { useBatchPrompt, type BatchTarget } from "./use-batch-prompt";

// Bảng bài đối thủ. Là client component vì cần state chọn nhiều dòng dùng chung
// (checkbox + "chọn tất cả" + chạy prompt hàng loạt). Page vẫn là server component.

// Link 1 dòng, dài thì cắt bằng CSS + hover ra full (repo không có component Tooltip).
function LinkCell({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={href}
      className="inline-flex max-w-full items-center gap-1 text-xs text-blue-600 hover:underline"
    >
      <ExternalLink className="size-3 shrink-0" />
      <span className="line-clamp-1 break-all">{label}</span>
    </a>
  );
}

export function CompetitorPostsTable({
  posts,
  pageHandle,
  pageId,
  sheetCopiedAt,
  lastScrapedAt,
}: {
  posts: CompetitorPostWithComments[];
  pageHandle: string;
  pageId: string;
  sheetCopiedAt: string | null;
  lastScrapedAt: string | null;
}) {
  // Link Source: cùng 1 giá trị cho mọi dòng (đang xem 1 page) nhưng vẫn để mỗi dòng một ô,
  // để copy cả hàng ra sheet là đủ 5 cột, không phải tự điền lại nguồn.
  const sourceUrl = competitorPageUrl(pageHandle);
  const now = useNow();

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
      <div className="flex justify-end">
        <ExportSheetButton posts={posts} sourceUrl={sourceUrl} pageId={pageId} sheetCopiedAt={sheetCopiedAt} lastScrapedAt={lastScrapedAt} />
      </div>

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
        <table className="w-full min-w-[1600px] text-sm">
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
              <th className="w-32 px-4 py-2 font-medium">Đăng lúc</th>
              <th className="w-24 px-4 py-2 font-medium">Link Source</th>
              <th className="w-28 px-4 py-2 font-medium">Link Post</th>
              <th className="w-[24%] px-4 py-2 font-medium">Caption FB</th>
              <th className="w-[24%] px-4 py-2 font-medium">Part 2</th>
              <th className="w-44 px-4 py-2 font-medium">Link Comment Post</th>
              <th className="w-[24%] px-4 py-2 font-medium">Prompt</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((post) => {
              // CHỈ comment của page — giờ DB lưu cả comment người ngoài (để không mất link của
              // họ), nhưng cột này vẫn phải là nội dung "Part 2" do page tự đăng như trước.
              const part2 = post.comments
                .filter((c) => c.is_page_author)
                .map((c) => (c.message ?? "").trim())
                .filter(Boolean)
                .join("\n\n");
              const links = collectPostLinks(post);

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

                  {/* Đăng lúc: giờ tuyệt đối + "x giờ trước" (biết bài còn tươi hay không) */}
                  <td className="px-4 py-3">
                    {post.fb_created_at ? (
                      <div className="space-y-0.5">
                        {/* now null = đang render ở server; chờ client mới hiện "x giờ trước" */}
                        {now !== null && (
                          <div className="text-xs font-medium">{relativeVN(post.fb_created_at, now)}</div>
                        )}
                        <div className="text-xs text-neutral-400">{formatVN(post.fb_created_at)}</div>
                      </div>
                    ) : (
                      <span className="text-xs text-neutral-400" title="FB không trả giờ đăng cho bài này">
                        không rõ giờ
                      </span>
                    )}
                  </td>

                  {/* Link Source: page đối thủ (giống nhau mọi dòng, để copy cả hàng cho đủ cột) */}
                  <td className="px-4 py-3">
                    <LinkCell href={sourceUrl} label={pageHandle} />
                  </td>

                  {/* Link Post: ảnh + giờ đăng + permalink bài gốc */}
                  <td className="px-4 py-3">
                    {post.media_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={post.media_url} alt="" className="mb-1.5 h-16 w-16 rounded-lg object-cover" />
                    )}
                    {post.permalink ? (
                      <div className="mt-1">
                        <LinkCell href={post.permalink} label="bài gốc" />
                      </div>
                    ) : (
                      <span className="text-xs text-neutral-400">—</span>
                    )}
                  </td>

                  {/* Caption FB */}
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

                  {/* Part 2: nội dung comment của chính page (nhiều comment thì nối lại) */}
                  <td className="px-4 py-3">
                    {part2 ? (
                      <div className="space-y-1.5">
                        <div className="flex justify-end">
                          <CopyButton text={part2} label="Copy part 2" />
                        </div>
                        <CollapsibleText text={part2} />
                      </div>
                    ) : (
                      <span className="text-neutral-400">(chưa có comment của page)</span>
                    )}
                  </td>

                  {/* Link Comment Post: MỌI link bóc được (caption + mọi comment), không chỉ cái đầu */}
                  <td className="px-4 py-3">
                    {links.length ? (
                      <div className="space-y-1">
                        {links.map((l) => (
                          <LinkCell key={l} href={l} label={l} />
                        ))}
                        {links.length > 1 && (
                          <div className="flex justify-end">
                            <CopyButton text={links.join("\n")} label={`Copy ${links.length} link`} />
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-neutral-400">—</span>
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
