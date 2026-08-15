// Port của lib/sync.ts cho Deno — logic Y HỆT bản Node, kể cả toàn bộ phần reconcile reel lên
// lịch (video id -> post id thật khi lên sóng). KHÔNG "dọn dẹp" gì trong lúc port — mọi nhánh xử
// lý merge/unique-violation giữ nguyên, đây là phần rủi ro cao nhất của cả app (sai là mất đồng bộ
// bài mới + có thể xoá nhầm comment đã hẹn).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decryptToken } from "./crypto.ts";
import {
  getPageFeed,
  getPageVideos,
  getScheduledPosts,
  extractMedia,
  FacebookError,
  type FbFeedItem,
  type FbVideoItem,
} from "./facebook.ts";

export interface SyncResult {
  pageId: string;
  name?: string;
  count: number;
  scheduledCount?: number;
  ok: boolean;
  error?: string;
  warning?: string;
}

function fbErrMsg(e: unknown): string {
  return e instanceof FacebookError
    ? `[FB ${e.code ?? ""}${e.subcode ? "/" + e.subcode : ""}] ${e.message}`
    : (e as Error).message;
}

function toPostRow(pageId: string, item: FbFeedItem, published: boolean) {
  const { mediaType, mediaUrl } = extractMedia(item);
  const scheduledIso =
    !published && item.scheduled_publish_time
      ? new Date(item.scheduled_publish_time * 1000).toISOString()
      : null;
  const fbCreatedAt = item.created_time ?? null;

  const comments = item.comments?.data ?? [];
  const pageComment = comments.find((c) => c.from?.id === pageId);
  const commentCount = item.comments?.summary?.total_count ?? comments.length;

  return {
    page_id: pageId,
    fb_post_id: item.id,
    message: item.message ?? null,
    permalink: item.permalink_url ?? null,
    media_type: mediaType,
    media_url: mediaUrl,
    fb_created_at: fbCreatedAt,
    is_published: published,
    scheduled_publish_time: scheduledIso,
    display_time: published ? fbCreatedAt : (scheduledIso ?? fbCreatedAt),
    page_commented: !!pageComment,
    comment_count: commentCount,
    reaction_count: item.reactions?.summary?.total_count ?? null,
    page_comment_at: pageComment?.created_time ?? null,
    raw: item as unknown,
    synced_at: new Date().toISOString(),
  };
}

function toVideoPostRow(pageId: string, v: FbVideoItem) {
  const scheduledIso = v.scheduled_publish_time ? new Date(v.scheduled_publish_time * 1000).toISOString() : null;
  const createdAt = v.created_time ?? null;
  return {
    page_id: pageId,
    fb_post_id: v.id,
    message: v.description ?? null,
    permalink: v.permalink_url ? `https://www.facebook.com${v.permalink_url}` : null,
    media_type: "reel",
    media_url: v.picture ?? null,
    fb_created_at: createdAt,
    is_published: false,
    scheduled_publish_time: scheduledIso,
    display_time: scheduledIso ?? createdAt,
    page_commented: false,
    comment_count: null,
    reaction_count: null,
    page_comment_at: null,
    raw: v as unknown,
    synced_at: new Date().toISOString(),
  };
}

export async function syncPage(db: SupabaseClient, pageId: string, opts: { limit?: number } = {}): Promise<SyncResult> {
  const { data: page, error } = await db
    .from("facebook_page")
    .select("page_id, name, access_token")
    .eq("page_id", pageId)
    .maybeSingle();
  if (error) throw error;
  if (!page) throw new Error(`Không tìm thấy page ${pageId}`);

  const p = page as { page_id: string; name: string; access_token: string };
  try {
    const token = decryptToken(p.access_token);

    const warnings: string[] = [];

    const feed = await getPageFeed(pageId, token, { limit: opts.limit ?? 25 });
    if (feed.reactionsIncluded === false) {
      warnings.push('Graph không trả reactions — "Cần đăng link WP" tạm chỉ dựa vào số comment.');
    }
    let scheduled: FbFeedItem[] = [];
    try {
      const sch = await getScheduledPosts(pageId, token);
      scheduled = sch.data ?? [];
    } catch (e) {
      warnings.push(`Không đọc được bài lên lịch: ${fbErrMsg(e)}`);
    }

    let unpublishedVideos: FbVideoItem[] = [];
    try {
      const vids = await getPageVideos(pageId, token, { limit: 50 });
      unpublishedVideos = (vids.data ?? []).filter((v) => v.published === false);
    } catch (e) {
      warnings.push(`Không đọc được video lên lịch: ${fbErrMsg(e)}`);
    }

    const feedItems = feed.data ?? [];
    const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const reelToPostId = new Map<string, string>();
    const msgCandidates = new Map<string, { id: string; n: number }>();
    for (const item of feedItems) {
      const m = item.permalink_url?.match(/\/reel\/(\d+)/);
      if (m) reelToPostId.set(m[1], item.id);
      const nm = norm(item.message);
      if (nm) {
        const c = msgCandidates.get(nm);
        if (c) c.n++;
        else msgCandidates.set(nm, { id: item.id, n: 1 });
      }
    }
    const stillUnpublished = new Set(unpublishedVideos.map((v) => v.id));
    {
      const { data: pending } = await db
        .from("post")
        .select("id, fb_post_id, message")
        .eq("page_id", pageId)
        .eq("is_published", false);
      const placeholders = ((pending ?? []) as { id: string; fb_post_id: string; message: string | null }[]).filter(
        (r) => !r.fb_post_id.includes("_") && !stillUnpublished.has(r.fb_post_id),
      );
      const phMsgCount = new Map<string, number>();
      for (const ph of placeholders) {
        const nm = norm(ph.message);
        if (nm) phMsgCount.set(nm, (phMsgCount.get(nm) ?? 0) + 1);
      }
      for (const ph of placeholders) {
        let realId = reelToPostId.get(ph.fb_post_id);
        if (!realId) {
          const nm = norm(ph.message);
          const cand = nm ? msgCandidates.get(nm) : undefined;
          if (cand && cand.n === 1 && phMsgCount.get(nm) === 1) realId = cand.id;
        }
        if (!realId || realId === ph.fb_post_id) continue;

        let commentsPostId = ph.id;
        const { error: mvErr } = await db.from("post").update({ fb_post_id: realId }).eq("id", ph.id);
        if (mvErr) {
          const { data: live } = await db.from("post").select("id").eq("fb_post_id", realId).maybeSingle();
          if (!live) {
            warnings.push(`Reconcile ${ph.fb_post_id} -> ${realId} lỗi: ${mvErr.message}`);
            continue;
          }
          commentsPostId = (live as { id: string }).id;
          const { data: moving } = await db.from("scheduled_comment").select("id").eq("post_id", ph.id);
          let moveFailed = false;
          for (const c of (moving ?? []) as { id: string }[]) {
            const { error: cErr } = await db
              .from("scheduled_comment")
              .update({ post_id: commentsPostId, fb_post_id: realId })
              .eq("id", c.id);
            if (!cErr) continue;
            if (cErr.code === "23505") {
              await db.from("scheduled_comment").delete().eq("id", c.id);
            } else {
              moveFailed = true;
              warnings.push(`Dời comment ${c.id} sang bài live ${realId} lỗi: ${cErr.message}`);
            }
          }
          if (moveFailed) continue;
          await db.from("scraped_article").update({ post_id: commentsPostId }).eq("post_id", ph.id);
          await db.from("post").delete().eq("id", ph.id);
        } else {
          await db.from("scheduled_comment").update({ fb_post_id: realId }).eq("post_id", ph.id);
        }
        const { data: failed } = await db
          .from("scheduled_comment")
          .select("id")
          .eq("post_id", commentsPostId)
          .eq("status", "FAILED");
        for (const c of (failed ?? []) as { id: string }[]) {
          await db
            .from("scheduled_comment")
            .update({ status: "PENDING", error: null, claimed_at: null })
            .eq("id", c.id);
        }
      }
    }

    const rows = [
      ...feedItems.map((item) => toPostRow(pageId, item, true)),
      ...scheduled.map((item) => toPostRow(pageId, item, false)),
      ...unpublishedVideos.map((v) => toVideoPostRow(pageId, v)),
    ];

    // Ảnh backup được chốt 1 LẦN theo media_url tại thời điểm đó (post-image-backup.ts). Một bài
    // reel đổi ảnh khi đăng: lúc lên lịch là `picture` từ /videos (~160px), đăng xong feed trả bản
    // lớn. Nếu không xoá mốc backup thì Storage kẹt bản nhỏ. So khớp bằng path + tham số `stp`
    // (kích thước) chứ KHÔNG so cả URL — FB đổi token `_nc_ohc/oh/oe` mỗi lần trả về, so nguyên
    // URL sẽ backup lại mỗi lượt cron.
    const mediaKey = (url: string | null): string | null => {
      if (!url) return null;
      try {
        const u = new URL(url);
        return `${u.pathname}|${u.searchParams.get("stp") ?? ""}`;
      } catch {
        return url;
      }
    };
    const { data: before } = await db.from("post").select("fb_post_id, media_url").eq("page_id", pageId);
    const oldKeys = new Map(
      ((before ?? []) as { fb_post_id: string; media_url: string | null }[]).map((r) => [
        r.fb_post_id,
        mediaKey(r.media_url),
      ]),
    );

    if (rows.length) {
      const { error: upErr } = await db.from("post").upsert(rows, { onConflict: "fb_post_id" });
      if (upErr) throw upErr;
    }

    const reBackup = rows
      .filter((r) => r.is_published && r.media_url)
      .filter((r) => {
        const old = oldKeys.get(r.fb_post_id);
        return old != null && old !== mediaKey(r.media_url);
      })
      .map((r) => r.fb_post_id);
    if (reBackup.length) {
      const { error: rbErr } = await db.from("post").update({ image_backup_at: null }).in("fb_post_id", reBackup);
      if (rbErr) warnings.push(`Không đặt lại mốc backup ảnh cho ${reBackup.length} bài: ${rbErr.message}`);
    }
    const scheduledCount = scheduled.length + unpublishedVideos.length;
    return {
      pageId,
      name: p.name,
      count: rows.length,
      scheduledCount,
      ok: true,
      warning: warnings.length ? warnings.join(" | ") : undefined,
    };
  } catch (e) {
    return { pageId, name: p.name, count: 0, ok: false, error: fbErrMsg(e) };
  }
}

export async function syncAllPages(db: SupabaseClient, opts: { limit?: number } = {}): Promise<SyncResult[]> {
  const { data: pages, error } = await db.from("facebook_page").select("page_id");
  if (error) throw error;
  const results: SyncResult[] = [];
  for (const row of (pages ?? []) as { page_id: string }[]) {
    try {
      results.push(await syncPage(db, row.page_id, opts));
    } catch (e) {
      results.push({ pageId: row.page_id, count: 0, ok: false, error: (e as Error).message });
    }
  }
  return results;
}
