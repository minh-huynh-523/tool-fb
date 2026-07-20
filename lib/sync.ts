import 'server-only';
import { createSupabaseAdmin } from './supabase/admin';
import { decryptToken } from './crypto';
import {
  getPageFeed,
  getPageVideos,
  getScheduledPosts,
  extractMedia,
  FacebookError,
  type FbFeedItem,
  type FbVideoItem,
} from './facebook/client';

export interface SyncResult {
  pageId: string;
  name?: string;
  count: number; // tổng số bài upsert (đã đăng + lên lịch)
  scheduledCount?: number; // số bài lên lịch lấy được
  ok: boolean;
  error?: string;
  warning?: string; // vd: đọc bài lên lịch thất bại (thiếu quyền) nhưng vẫn sync bài đã đăng
}

function fbErrMsg(e: unknown): string {
  return e instanceof FacebookError
    ? `[FB ${e.code ?? ''}${e.subcode ? '/' + e.subcode : ''}] ${e.message}`
    : (e as Error).message;
}

// Map 1 feed item -> row `post`. `published` quyết định is_published + display_time.
function toPostRow(pageId: string, item: FbFeedItem, published: boolean) {
  const { mediaType, mediaUrl } = extractMedia(item);
  const scheduledIso =
    !published && item.scheduled_publish_time
      ? new Date(item.scheduled_publish_time * 1000).toISOString()
      : null;
  const fbCreatedAt = item.created_time ?? null;

  // Trạng thái comment THẬT từ FB: page đã tự comment bài này chưa (from.id === page_id).
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
    // ?? null chứ TUYỆT ĐỐI không ?? 0: hàm này cũng chạy cho item từ /scheduled_posts (chuỗi field
    // riêng, không xin reactions) và cho ca fallback ở getPageFeed. 0 sẽ là nói dối "không ai thả".
    reaction_count: item.reactions?.summary?.total_count ?? null,
    page_comment_at: pageComment?.created_time ?? null,
    raw: item as unknown,
    synced_at: new Date().toISOString(),
  };
}

// Map 1 video CHƯA publish (reel lên lịch/draft Business Suite) -> row `post` dạng "Lên lịch".
// fb_post_id tạm = video id; khi bài lên sóng sẽ được reconcile sang post id thật (xem syncPage).
function toVideoPostRow(pageId: string, v: FbVideoItem) {
  const scheduledIso = v.scheduled_publish_time ? new Date(v.scheduled_publish_time * 1000).toISOString() : null;
  const createdAt = v.created_time ?? null; // giờ upload/lên lịch — Business Suite KHÔNG cho biết giờ sẽ đăng
  return {
    page_id: pageId,
    fb_post_id: v.id,
    message: v.description ?? null,
    permalink: v.permalink_url ? `https://www.facebook.com${v.permalink_url}` : null,
    media_type: 'reel',
    media_url: v.picture ?? null,
    fb_created_at: createdAt,
    is_published: false,
    scheduled_publish_time: scheduledIso,
    display_time: scheduledIso ?? createdAt,
    page_commented: false,
    comment_count: null,
    // Bài chưa lên sóng thì không có tương tác. Key vẫn phải CÓ MẶT: Supabase bulk upsert đòi
    // mọi row trong cùng batch có y hệt bộ key.
    reaction_count: null,
    page_comment_at: null,
    raw: v as unknown,
    synced_at: new Date().toISOString(),
  };
}

// Đồng bộ 1 page -> upsert vào `post` (idempotent theo fb_post_id).
// Lấy: bài đã đăng (/posts) + bài lên lịch qua API (/scheduled_posts)
//    + reel lên lịch Business Suite (/videos với published=false — cách DUY NHẤT thấy chúng).
export async function syncPage(pageId: string, opts: { limit?: number } = {}): Promise<SyncResult> {
  const db = createSupabaseAdmin();
  const { data: page, error } = await db
    .from('facebook_page')
    .select('page_id, name, access_token')
    .eq('page_id', pageId)
    .maybeSingle();
  if (error) throw error;
  if (!page) throw new Error(`Không tìm thấy page ${pageId}`);

  const p = page as { page_id: string; name: string; access_token: string };
  try {
    const token = decryptToken(p.access_token);

    const warnings: string[] = [];

    // Bài đã đăng (bắt buộc) + bài lên lịch (fail-mềm nếu token thiếu quyền).
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

    // Reel lên lịch Business Suite: /videos, lọc published=false (fail-mềm).
    let unpublishedVideos: FbVideoItem[] = [];
    try {
      const vids = await getPageVideos(pageId, token, { limit: 50 });
      unpublishedVideos = (vids.data ?? []).filter((v) => v.published === false);
    } catch (e) {
      warnings.push(`Không đọc được video lên lịch: ${fbErrMsg(e)}`);
    }

    // RECONCILE: khi reel lên lịch publish, Meta XOÁ video cũ và tạo video/post id MỚI
    // (đã verify: video 1322134606654176 -> reel 3134990026693803, description giống hệt 100%).
    // Vì id không ổn định, match placeholder với post live bằng: (1) permalink /reel/{videoId}
    // nếu id còn giữ, (2) NỘI DUNG message giống hệt (normalized). Đổi fb_post_id của row cũ
    // sang post id thật TRƯỚC khi upsert để không tạo row trùng và giữ comment đã hẹn.
    const feedItems = feed.data ?? [];
    const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    const reelToPostId = new Map<string, string>();
    // Message match phải DUY NHẤT 2 chiều (1 bài live ↔ 1 placeholder) — caption template trùng
    // nhau giữa nhiều bài sẽ bị bỏ qua thay vì retarget nhầm bài.
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
      // Placeholder = row lên lịch có fb_post_id là VIDEO id (không có "_"; post id thật dạng {page}_{post}).
      const { data: pending } = await db
        .from('post')
        .select('id, fb_post_id, message')
        .eq('page_id', pageId)
        .eq('is_published', false);
      const placeholders = ((pending ?? []) as { id: string; fb_post_id: string; message: string | null }[]).filter(
        (r) => !r.fb_post_id.includes('_') && !stillUnpublished.has(r.fb_post_id),
      );
      // Đếm message trùng giữa chính các placeholder — trùng thì không dám match.
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
        if (!realId || realId === ph.fb_post_id) continue; // chưa thấy bản live / match nhập nhằng -> thử lại lần sync sau

        let commentsPostId = ph.id; // uuid mà comment đã hẹn đang trỏ tới (đổi nếu merge)
        const { error: mvErr } = await db.from('post').update({ fb_post_id: realId }).eq('id', ph.id);
        if (mvErr) {
          // Thường là unique violation: row bài live đã tồn tại riêng (sync đua nhau) -> MERGE:
          // dời comment đã hẹn sang row live rồi xoá placeholder (không nuốt lỗi im lặng nữa).
          const { data: live } = await db.from('post').select('id').eq('fb_post_id', realId).maybeSingle();
          if (!live) {
            warnings.push(`Reconcile ${ph.fb_post_id} -> ${realId} lỗi: ${mvErr.message}`);
            continue;
          }
          commentsPostId = (live as { id: string }).id;
          await db.from('scheduled_comment').update({ post_id: commentsPostId, fb_post_id: realId }).eq('post_id', ph.id);
          await db.from('scraped_article').update({ post_id: commentsPostId }).eq('post_id', ph.id); // best-effort (unique post_id)
          await db.from('post').delete().eq('id', ph.id);
        } else {
          // Retarget comment đã hẹn sang post id thật để worker gửi đúng chỗ.
          await db.from('scheduled_comment').update({ fb_post_id: realId }).eq('post_id', ph.id);
        }
        // Comment FAILED (fail vì bắn vào video id chết trước khi reconcile) -> PENDING để thử lại.
        await db
          .from('scheduled_comment')
          .update({ status: 'PENDING', error: null, claimed_at: null })
          .eq('post_id', commentsPostId)
          .eq('status', 'FAILED');
      }
    }

    const rows = [
      ...feedItems.map((item) => toPostRow(pageId, item, true)),
      ...scheduled.map((item) => toPostRow(pageId, item, false)),
      ...unpublishedVideos.map((v) => toVideoPostRow(pageId, v)),
    ];
    if (rows.length) {
      const { error: upErr } = await db.from('post').upsert(rows, { onConflict: 'fb_post_id' });
      if (upErr) throw upErr;
    }
    const scheduledCount = scheduled.length + unpublishedVideos.length;
    return {
      pageId,
      name: p.name,
      count: rows.length,
      scheduledCount,
      ok: true,
      warning: warnings.length ? warnings.join(' | ') : undefined,
    };
  } catch (e) {
    return { pageId, name: p.name, count: 0, ok: false, error: fbErrMsg(e) };
  }
}

// Đồng bộ tất cả page (tuần tự — tránh rate limit; 1 page lỗi không hỏng cả batch).
export async function syncAllPages(opts: { limit?: number } = {}): Promise<SyncResult[]> {
  const db = createSupabaseAdmin();
  const { data: pages, error } = await db.from('facebook_page').select('page_id');
  if (error) throw error;
  const results: SyncResult[] = [];
  for (const row of (pages ?? []) as { page_id: string }[]) {
    try {
      results.push(await syncPage(row.page_id, opts));
    } catch (e) {
      results.push({ pageId: row.page_id, count: 0, ok: false, error: (e as Error).message });
    }
  }
  return results;
}
