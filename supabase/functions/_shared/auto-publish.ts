// Port của Stage 1 (enqueueWpContentCandidates) trong lib/auto-publish.ts cho Deno — logic Y HỆT
// bản Node. Stage 2/3 (processWpContentQueue/processWpPublishQueue) đã có port riêng ở
// wp-content/index.ts và wp-publish/index.ts từ trước, không lặp lại ở đây.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

interface Candidate {
  id: string;
  comment_count: number | null;
  reaction_count: number | null;
  page_commented: boolean;
  media_url: string | null;
  image_backup_at: string | null;
}

function autoPublishThresholds(): { minReactions: number; minComments: number } {
  const minReactions = Number(Deno.env.get("AUTO_PUBLISH_MIN_REACTIONS") ?? 8);
  const minComments = Number(Deno.env.get("AUTO_PUBLISH_MIN_COMMENTS") ?? 2);
  return { minReactions, minComments };
}

// Port Y HỆT hourTodayVNISO (lib/date.ts) — VN = UTC+7, không DST nên offset cố định.
function hourTodayVNISO(hour: number): string {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 3600 * 1000); // dịch sang giờ VN
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth();
  const d = vn.getUTCDate();
  const utcMs = Date.UTC(y, m, d, hour, 0, 0) - 7 * 3600 * 1000; // giờ cắt hôm nay (VN) quy về UTC
  return new Date(utcMs).toISOString();
}

function todaySinceCutoff(): { fromIso: string; toIso: string } {
  const cutoffHour = Number(Deno.env.get("AUTO_PUBLISH_CUTOFF_HOUR") ?? 12);
  return { fromIso: hourTodayVNISO(cutoffHour), toIso: new Date().toISOString() };
}

export async function enqueueWpContentCandidates(
  db: SupabaseClient,
  window?: { fromIso: string; toIso: string },
): Promise<{ enqueued: number }> {
  const { minReactions, minComments } = autoPublishThresholds();
  const { fromIso, toIso } = window ?? todaySinceCutoff();

  const { data, error } = await db
    .from("post")
    .select(
      "id, comment_count, reaction_count, page_commented, media_url, image_backup_at, scraped_article!left(post_id)",
    )
    .eq("is_published", true)
    .is("scraped_article", null)
    .is("wp_dismissed_at", null)
    .gte("fb_created_at", fromIso)
    .lte("fb_created_at", toIso);
  if (error) throw new Error(`Đọc bài đủ ngưỡng auto-publish lỗi: ${error.message}`);

  // Chặn thêm: bài CÓ ảnh nhưng CHƯA được thử backup vào Supabase Storage thì CHƯA đủ điều kiện
  // enqueue — xem lib/auto-publish.ts bản Next.js để biết lý do đầy đủ (Stage 2 chốt image_url
  // 1 lần duy nhất, enqueue sớm quá sẽ kẹt bài không ảnh).
  const due = ((data ?? []) as Candidate[])
    .filter((p) => p.media_url === null || p.image_backup_at !== null)
    .filter((p) => {
      const real = (p.comment_count ?? 0) - (p.page_commented ? 1 : 0);
      return (p.reaction_count ?? 0) >= minReactions || real >= minComments;
    });
  if (!due.length) return { enqueued: 0 };

  const { error: insErr } = await db
    .from("wp_content_queue")
    .upsert(
      due.map((p) => ({ post_id: p.id })),
      { onConflict: "post_id", ignoreDuplicates: true },
    );
  if (insErr) throw new Error(`Ghi wp_content_queue lỗi: ${insErr.message}`);
  return { enqueued: due.length };
}
