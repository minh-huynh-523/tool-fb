import 'server-only';
import { createSupabaseAdmin } from './supabase/admin';
import { decryptToken } from './crypto';
import { getPostComments, type FbComment } from './facebook/client';
import { clampThresholds, type AttentionThresholds } from './attention';
import type {
  CommentHistoryRow,
  CommentStatus,
  CompetitorCommentRow,
  CompetitorPageRow,
  CompetitorPostRow,
  PromptTemplateRow,
  FacebookPageRow,
  PostRow,
  ScheduledCommentRow,
} from './types';

export type SafePage = Omit<FacebookPageRow, 'access_token'>;

// Cột tường minh — KHÔNG lấy `raw` (jsonb lớn, không render) để tránh over-fetch.
const POST_COLUMNS =
  'id, page_id, fb_post_id, message, permalink, media_type, media_url, fb_created_at, is_published, scheduled_publish_time, display_time, page_commented, comment_count, reaction_count, page_comment_at, wp_dismissed_at, synced_at, created_at, image_backup_url, image_backup_at, image_backup_error';

export async function listPages(): Promise<SafePage[]> {
  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from('facebook_page')
    .select('id, page_id, name, picture, token_expires_at, wp_xmlrpc_url, wp_base_url, wp_category, created_at, updated_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as SafePage[];
}

// Trạng thái auto-publish (lib/auto-publish.ts, migration 0024) cho 1 post — 'publish' đi trước
// 'content' vì nó nằm ở giai đoạn sau trong pipeline: có hàng ở wp_publish_queue thì hàng
// wp_content_queue chỉ còn là lịch sử (đã DONE), không phải trạng thái "đang treo" cần hiện.
export interface AutoPublishStatus {
  stage: 'content' | 'publish';
  status: string; // content: PENDING|PROCESSING|DONE|FAILED — publish: PENDING|PROCESSING|PUBLISHED|FAILED
  attempts: number;
  error: string | null;
  permalink: string | null; // chỉ có ở stage 'publish'
}

export interface PostWithComment extends PostRow {
  commentStatus: CommentStatus | null;
  commentCounts: Partial<Record<CommentStatus, number>>;
  comments: CommentHistoryRow[]; // lịch sử comment của mình cho bài này (mới lên lịch → đã đăng/lỗi)
  wp: {
    wp_post_id: string | null;
    wp_edit_url: string | null;
    wp_status: string | null;
    wp_permalink: string | null;
    source_url: string | null;
  } | null;
  autoPublish: AutoPublishStatus | null;
}

// Row cũ chưa có wp_permalink (trước migration 0006) -> tự dựng link ?p=ID từ wp_post_id (vẫn dùng được).
function resolvePermalink(row: { wp_permalink: string | null; wp_post_id: string | null }): string | null {
  if (row.wp_permalink) return row.wp_permalink;
  const base = process.env.WP_BASE_URL ?? '';
  return base && row.wp_post_id ? `${base}/?p=${row.wp_post_id}` : null;
}

export interface ListPostsResult {
  rows: PostWithComment[];
  total: number;
  page: number;
  pageSize: number;
}

function summarize(counts: Partial<Record<CommentStatus, number>>): CommentStatus | null {
  if (counts.SENT) return 'SENT';
  if (counts.PROCESSING) return 'PROCESSING';
  if (counts.PENDING) return 'PENDING';
  if (counts.FAILED) return 'FAILED';
  return null;
}

/**
 * Vế "đang có tương tác" của hàng đợi WP, dạng filter string của PostgREST.
 *
 * clampThresholds() đã ép số nguyên, nhưng clamp LẠI ở đây vì .or() nhận raw string: hàm này là
 * chỗ duy nhất giá trị chui vào câu query, nên nó phải tự bảo vệ được kể cả khi ai đó gọi thẳng.
 *
 * reaction_count NULL tự rớt khỏi vế `gt` (NULL không so sánh được) — đúng ý: bài chưa sync
 * reaction thì đừng đoán, vẫn còn vế comment để nổi lên.
 */
function needsWpOrFilter(t: AttentionThresholds): string {
  const minR = Math.min(10_000, Math.max(0, Math.trunc(t.minReactions)));
  const minC = Math.min(10_000, Math.max(1, Math.trunc(t.minComments)));
  return `reaction_count.gt.${minR},comment_count.gte.${minC}`;
}

/** Ngưỡng từ env — nguồn sự thật cho badge sidebar. Server-only vì đọc process.env. */
export function envThresholds(): AttentionThresholds {
  return clampThresholds(process.env.WP_ATTENTION_MIN_REACTIONS, process.env.WP_ATTENTION_MIN_COMMENTS);
}

/**
 * Chỉ ĐẾM cho badge sidebar — head:true để PostgREST không trả về row nào, chỉ header Content-Range.
 * Phải khớp từng filter với nhánh needsWp ở listPostsWithCommentStatus, nếu không badge sẽ nói
 * một số mà trang lại hiện số khác.
 */
export async function countPostsNeedingWp(t: AttentionThresholds): Promise<number> {
  const db = createSupabaseAdmin();
  const { count, error } = await db
    .from('post')
    .select('id, scraped_article!left(post_id)', { count: 'exact', head: true })
    .is('scraped_article', null)
    .eq('is_published', true)
    .is('wp_dismissed_at', null)
    .or(needsWpOrFilter(t));
  if (error) throw error;
  return count ?? 0;
}

export interface PostFilter {
  pageId?: string;
  status?: 'PUBLISHED' | 'SCHEDULED';
  from?: string; // ISO — lọc display_time >=
  to?: string; // ISO — lọc display_time <=
  uncommented?: boolean;
  // Hàng đợi "Cần đăng link WP": bài đã đăng, CHƯA có scraped_article nào, chưa bỏ qua,
  // và vượt một trong hai ngưỡng tương tác. Xem lib/attention.ts.
  // dismissedOnly: lật sang xem ĐÚNG những bài đã bỏ qua (để hoàn tác), không phải gộp cả hai.
  needsWp?: AttentionThresholds & { dismissedOnly?: boolean };
  page?: number;
  pageSize?: number;
}

export async function listPostsWithCommentStatus(filter: PostFilter): Promise<ListPostsResult> {
  const db = createSupabaseAdmin();
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20));

  // "Chưa comment" = page CHƯA tự comment bài (page_commented=false — dữ liệu thật từ FB).
  // count: 'exact' GỘP đếm tổng vào cùng 1 request với data — tiết kiệm 1 round-trip Supabase.
  const offset = (page - 1) * pageSize;
  // Embed scraped_article CHỈ khi cần anti-join — /posts không phải trả giá cho cái join này.
  const cols = filter.needsWp ? `${POST_COLUMNS}, scraped_article!left(post_id)` : POST_COLUMNS;
  let dataQ = db
    .from('post')
    .select(cols, { count: 'exact' })
    .order('display_time', { ascending: false, nullsFirst: false })
    .range(offset, offset + pageSize - 1);
  if (filter.pageId) dataQ = dataQ.eq('page_id', filter.pageId);
  if (filter.status === 'PUBLISHED') dataQ = dataQ.eq('is_published', true);
  if (filter.status === 'SCHEDULED') dataQ = dataQ.eq('is_published', false);
  if (filter.from) dataQ = dataQ.gte('display_time', filter.from);
  if (filter.to) dataQ = dataQ.lte('display_time', filter.to);
  if (filter.uncommented) dataQ = dataQ.eq('page_commented', false);
  if (filter.needsWp) {
    // ANTI-JOIN: `!left` ép LEFT JOIN rồi .is('<tên embed>', null) = "không có scraped_article nào".
    // Đây là cách PostgREST diễn đạt NOT EXISTS. KHÔNG dùng .not('id','in',(...)) vì danh sách id
    // sẽ phình URL và vỡ khi số bài lớn.
    dataQ = dataQ
      .is('scraped_article', null)
      .eq('is_published', true)
      .or(needsWpOrFilter(filter.needsWp));
    dataQ = filter.needsWp.dismissedOnly
      ? dataQ.not('wp_dismissed_at', 'is', null)
      : dataQ.is('wp_dismissed_at', null);
  }

  const { data: posts, count, error } = await dataQ;
  if (error) throw error;
  const total = count ?? 0;
  // Bỏ cột embed trước khi cast: nó chỉ dùng để lọc chứ không phải dữ liệu của PostRow, và để
  // nguyên thì nó sẽ theo props chảy xuống client component.
  // Qua `unknown` vì `cols` là string động -> parser kiểu của supabase-js không suy được shape.
  const list = ((posts ?? []) as unknown as Array<PostRow & { scraped_article?: unknown }>).map((row) => {
    const p = { ...row };
    delete p.scraped_article;
    return p as PostRow;
  });
  if (!list.length) return { rows: [], total, page, pageSize };

  // Lịch sử comment (của mình) + bài WP + trạng thái auto-publish cho các post của trang hiện
  // tại — 4 query độc lập, chạy SONG SONG để tiết kiệm round-trip Supabase.
  const ids = list.map((p) => p.id);
  const [{ data: comments }, { data: scraped }, { data: contentQ }, { data: publishQ }] = await Promise.all([
    db
      .from('scheduled_comment')
      .select('id, post_id, message, attachment_url, run_after, status, attempts, sent_at, error, created_at')
      .in('post_id', ids)
      .order('run_after', { ascending: true }),
    db
      .from('scraped_article')
      .select('post_id, wp_post_id, wp_edit_url, wp_status, wp_permalink, source_url')
      .in('post_id', ids),
    db.from('wp_content_queue').select('post_id, status, attempts, error').in('post_id', ids),
    db.from('wp_publish_queue').select('post_id, status, attempts, error, permalink').in('post_id', ids),
  ]);

  const byPost = new Map<string, Partial<Record<CommentStatus, number>>>();
  const commentsByPost = new Map<string, CommentHistoryRow[]>();
  for (const c of (comments ?? []) as CommentHistoryRow[]) {
    const m = byPost.get(c.post_id) ?? {};
    m[c.status] = (m[c.status] ?? 0) + 1;
    byPost.set(c.post_id, m);
    const arr = commentsByPost.get(c.post_id) ?? [];
    arr.push(c);
    commentsByPost.set(c.post_id, arr);
  }

  const wpByPost = new Map<string, PostWithComment['wp']>();
  for (const s of (scraped ?? []) as {
    post_id: string;
    wp_post_id: string | null;
    wp_edit_url: string | null;
    wp_status: string | null;
    wp_permalink: string | null;
    source_url: string | null;
  }[]) {
    wpByPost.set(s.post_id, {
      wp_post_id: s.wp_post_id,
      wp_edit_url: s.wp_edit_url,
      wp_status: s.wp_status,
      wp_permalink: resolvePermalink(s),
      source_url: s.source_url,
    });
  }

  // 'publish' đi trước 'content': có hàng ở wp_publish_queue thì hàng wp_content_queue chỉ còn
  // là lịch sử (đã DONE) — trạng thái "đang treo" cần hiện luôn là hàng ở giai đoạn sau.
  const autoPublishByPost = new Map<string, AutoPublishStatus>();
  for (const c of (contentQ ?? []) as { post_id: string; status: string; attempts: number; error: string | null }[]) {
    autoPublishByPost.set(c.post_id, { stage: 'content', status: c.status, attempts: c.attempts, error: c.error, permalink: null });
  }
  for (const p of (publishQ ?? []) as {
    post_id: string;
    status: string;
    attempts: number;
    error: string | null;
    permalink: string | null;
  }[]) {
    autoPublishByPost.set(p.post_id, { stage: 'publish', status: p.status, attempts: p.attempts, error: p.error, permalink: p.permalink });
  }

  const rows: PostWithComment[] = list.map((p) => {
    const counts = byPost.get(p.id) ?? {};
    return {
      ...p,
      commentStatus: summarize(counts),
      commentCounts: counts,
      autoPublish: autoPublishByPost.get(p.id) ?? null,
      comments: commentsByPost.get(p.id) ?? [],
      wp: wpByPost.get(p.id) ?? null,
    };
  });

  return { rows, total, page, pageSize };
}

export async function getPostWithComments(postDbId: string): Promise<{
  post: PostRow;
  comments: ScheduledCommentRow[];
  scraped: {
    wp_post_id: string | null;
    wp_edit_url: string | null;
    wp_status: string | null;
    wp_permalink: string | null;
    source_url: string | null;
  } | null;
  autoPublish: AutoPublishStatus | null;
} | null> {
  const db = createSupabaseAdmin();
  // 5 query độc lập (cùng key postDbId) — chạy song song, tiết kiệm round-trip.
  const [{ data: post, error }, { data: comments }, { data: scraped }, { data: contentQ }, { data: publishQ }] =
    await Promise.all([
      db.from('post').select(POST_COLUMNS).eq('id', postDbId).maybeSingle(),
      db.from('scheduled_comment').select('*').eq('post_id', postDbId).order('created_at', { ascending: false }),
      db
        .from('scraped_article')
        .select('wp_post_id, wp_edit_url, wp_status, wp_permalink, source_url')
        .eq('post_id', postDbId)
        .maybeSingle(),
      db.from('wp_content_queue').select('status, attempts, error').eq('post_id', postDbId).maybeSingle(),
      db.from('wp_publish_queue').select('status, attempts, error, permalink').eq('post_id', postDbId).maybeSingle(),
    ]);
  if (error) throw error;
  if (!post) return null;
  const s = scraped as {
    wp_post_id: string | null;
    wp_edit_url: string | null;
    wp_status: string | null;
    wp_permalink: string | null;
    source_url: string | null;
  } | null;
  // 'publish' đi trước 'content' — cùng lý do với listPostsWithCommentStatus.
  const pubRow = publishQ as { status: string; attempts: number; error: string | null; permalink: string | null } | null;
  const contRow = contentQ as { status: string; attempts: number; error: string | null } | null;
  const autoPublish: AutoPublishStatus | null = pubRow
    ? { stage: 'publish', status: pubRow.status, attempts: pubRow.attempts, error: pubRow.error, permalink: pubRow.permalink }
    : contRow
      ? { stage: 'content', status: contRow.status, attempts: contRow.attempts, error: contRow.error, permalink: null }
      : null;
  return {
    post: post as PostRow,
    autoPublish,
    comments: (comments ?? []) as ScheduledCommentRow[],
    scraped: s ? { ...s, wp_permalink: resolvePermalink(s) } : null,
  };
}

export interface AutoPublishQueueRow extends AutoPublishStatus {
  postId: string;
  createdAt: string;
  post: { id: string; message: string | null; media_url: string | null; page_id: string } | null;
}

export interface ListAutoPublishQueueResult {
  rows: AutoPublishQueueRow[];
  total: number;
  page: number;
  pageSize: number;
}

// Trang /link-comments — theo dõi hàng đợi auto-publish (lib/auto-publish.ts, migration 0024)
// xuyên suốt mọi bài: bài nào đang chờ/đang sinh nội dung Gemini, bài nào đang chờ/đã đăng WP,
// bài nào lỗi. Gộp wp_content_queue + wp_publish_queue theo post_id, ưu tiên hàng 'publish' (giai
// đoạn sau) — cùng logic precedence với listPostsWithCommentStatus/getPostWithComments ở trên.
// Merge ở JS vì PostgREST không UNION được; 2 bảng còn nhỏ (auto-publish mới ra) nên fetch hết
// rồi paginate trong JS, chưa cần UNION SQL.
export async function listAutoPublishQueue(filter: {
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<ListAutoPublishQueueResult> {
  const db = createSupabaseAdmin();
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20));

  const [{ data: contentRows, error: cErr }, { data: publishRows, error: pErr }] = await Promise.all([
    db.from('wp_content_queue').select('post_id, status, attempts, error, created_at').order('created_at', { ascending: false }),
    db
      .from('wp_publish_queue')
      .select('post_id, status, attempts, error, permalink, created_at')
      .order('created_at', { ascending: false }),
  ]);
  if (cErr) throw cErr;
  if (pErr) throw pErr;

  const merged = new Map<string, AutoPublishQueueRow>();
  for (const c of (contentRows ?? []) as { post_id: string; status: string; attempts: number; error: string | null; created_at: string }[]) {
    merged.set(c.post_id, {
      postId: c.post_id,
      post: null,
      stage: 'content',
      status: c.status,
      attempts: c.attempts,
      error: c.error,
      permalink: null,
      createdAt: c.created_at,
    });
  }
  for (const p of (publishRows ?? []) as {
    post_id: string;
    status: string;
    attempts: number;
    error: string | null;
    permalink: string | null;
    created_at: string;
  }[]) {
    merged.set(p.post_id, {
      postId: p.post_id,
      post: null,
      stage: 'publish',
      status: p.status,
      attempts: p.attempts,
      error: p.error,
      permalink: p.permalink,
      createdAt: p.created_at,
    });
  }

  let rows = Array.from(merged.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  const total = rows.length;
  const offset = (page - 1) * pageSize;
  rows = rows.slice(offset, offset + pageSize);

  if (rows.length) {
    const ids = rows.map((r) => r.postId);
    const { data: posts, error: postErr } = await db.from('post').select('id, message, media_url, page_id').in('id', ids);
    if (postErr) throw postErr;
    const postById = new Map(
      ((posts ?? []) as { id: string; message: string | null; media_url: string | null; page_id: string }[]).map((p) => [p.id, p]),
    );
    for (const r of rows) r.post = postById.get(r.postId) ?? null;
  }

  return { rows, total, page, pageSize };
}

// Comment THẬT của bài lấy trực tiếp từ Facebook (dùng ở trang chi tiết). Fail-mềm nếu FB lỗi.
export async function getLivePostComments(
  fbPostId: string,
  pageId: string,
): Promise<{ comments: FbComment[]; total: number; pageId: string } | null> {
  const db = createSupabaseAdmin();
  const { data: page } = await db
    .from('facebook_page')
    .select('access_token')
    .eq('page_id', pageId)
    .maybeSingle();
  if (!page) return null;
  try {
    const token = decryptToken((page as { access_token: string }).access_token);
    const res = await getPostComments(fbPostId, token, { limit: 50 });
    return { comments: res.data, total: res.summary?.total_count ?? res.data.length, pageId };
  } catch {
    return null; // thiếu quyền / FB lỗi -> không chặn trang chi tiết
  }
}

// =========================================================
// Page ĐỐI THỦ (cào bằng worker Playwright ở laptop) — Vercel CHỈ đọc.
// =========================================================
export interface CompetitorPageWithCount extends CompetitorPageRow {
  post_count: number;
  newest_post_at: string | null; // giờ đăng của bài mới nhất — để so với sheet_copied_at
  recent_post_count: number; // số bài đăng trong RECENT_WINDOW_HOURS giờ gần nhất
}

/**
 * Cửa sổ "bài mới" của trang đối thủ. Khớp với FB_SCRAPE_MAX_AGE_HOURS (mặc định 6) — worker chỉ
 * GIỮ bài trong ngần đó giờ, nên cột này trả lời đúng câu "lượt cào vừa rồi có moi được gì không".
 * Hằng ở đây chứ không đọc env: env đó là của worker chạy ở laptop, web trên Vercel không có nó,
 * đọc vào sẽ ra undefined và cửa sổ tụt về 0.
 */
export const RECENT_WINDOW_HOURS = 6;

// sheetState()/SheetState nằm ở lib/sheet-state.ts — client component cũng cần dùng, mà
// import từ file này sẽ kéo theo 'server-only'.

export async function listCompetitorPages(): Promise<CompetitorPageWithCount[]> {
  const db = createSupabaseAdmin();
  // newest_post: embed thứ 2 của cùng bảng, sort giảm dần + limit 1 = bài mới nhất.
  // Rẻ hơn nhiều so với kéo hết post về rồi tự tìm max.
  //
  // recent_post: embed thứ 3, count có filter thời gian. Đã verify trên 25 page thật rằng filter
  // .gte('recent.fb_created_at', …) CÓ áp vào count (không phải tổng số bài), và KHÔNG lọc mất
  // page cha — page 0 bài mới vẫn về đủ với count 0.
  const cutoff = new Date(Date.now() - RECENT_WINDOW_HOURS * 3600_000).toISOString();
  const { data, error } = await db
    .from('competitor_page')
    .select('*, competitor_post(count), newest_post:competitor_post(fb_created_at), recent_post:competitor_post(count)')
    .gte('recent_post.fb_created_at', cutoff)
    .order('fb_created_at', { referencedTable: 'newest_post', ascending: false, nullsFirst: false })
    .limit(1, { referencedTable: 'newest_post' })
    .order('active', { ascending: false })
    .order('name', { ascending: true, nullsFirst: false });
  if (error) throw error;
  // Supabase trả competitor_post: [{ count }] -> phẳng thành post_count.
  return (data ?? []).map((r) => {
    const { competitor_post, newest_post, recent_post, ...rest } = r as CompetitorPageRow & {
      competitor_post?: Array<{ count: number }>;
      newest_post?: Array<{ fb_created_at: string | null }>;
      recent_post?: Array<{ count: number }>;
    };
    return {
      ...rest,
      post_count: competitor_post?.[0]?.count ?? 0,
      newest_post_at: newest_post?.[0]?.fb_created_at ?? null,
      recent_post_count: recent_post?.[0]?.count ?? 0,
    } as CompetitorPageWithCount;
  });
}

// Liệt kê cột tường minh để BỎ `prompt_raw` (nguyên văn Gemini, rất dài — chỉ cần khi
// user bấm "Xem bản gốc", lúc đó lấy từ response POST). Cùng lý do POST_COLUMNS bỏ `raw`.
const COMPETITOR_POST_COLUMNS = `
  id, competitor_page_id, fb_post_id, permalink, caption, caption_link_urls, comment_link_urls,
  links_scanned_at, media_type, media_url, fb_created_at, raw, scraped_at, created_at,
  sheet_copied_at,
  story_analysis, prompt_image, prompt_video, prompt_model, prompt_at, prompt_error,
  part2_generated, part2_generated_at, part2_generated_error
`;

export interface CompetitorPostWithComments extends CompetitorPostRow {
  comments: CompetitorCommentRow[];
}
export interface CompetitorPageDetail {
  page: CompetitorPageRow;
  posts: CompetitorPostWithComments[];
}

export async function getCompetitorPageWithPosts(id: string): Promise<CompetitorPageDetail | null> {
  const db = createSupabaseAdmin();
  const { data: page, error } = await db.from('competitor_page').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!page) return null;

  const { data: posts } = await db
    .from('competitor_post')
    .select(`${COMPETITOR_POST_COLUMNS}, competitor_comment(*)`)
    .eq('competitor_page_id', id)
    .order('fb_created_at', { ascending: false, nullsFirst: false })
    .order('scraped_at', { ascending: false });

  const mapped = (posts ?? []).map((p) => {
    const { competitor_comment, ...rest } = p as CompetitorPostRow & { competitor_comment?: CompetitorCommentRow[] };
    return { ...rest, comments: competitor_comment ?? [] } as CompetitorPostWithComments;
  });
  return { page: page as CompetitorPageRow, posts: mapped };
}

// Prompt gửi Gemini ('main' = mega-prompt ảnh/video, 'part2' = fallback Part 2 [0022], 'wp_article'
// = bài WP từ caption FB [0023]). Null = migration tương ứng chưa chạy hoặc chưa seed.
export async function getPromptTemplate(
  kind: 'main' | 'part2' | 'wp_article' = 'main',
): Promise<PromptTemplateRow | null> {
  const db = createSupabaseAdmin();
  const { data, error } = await db.from('prompt_template').select('*').eq('kind', kind).maybeSingle();
  if (error) throw error;
  return (data as PromptTemplateRow) ?? null;
}

export interface ScraperStatus {
  sessionExpired: boolean;
  sessionExpiredAt: string | null;
}

// Trạng thái phiên FB dùng để cào đối thủ (bảng singleton scraper_status, migration 0021) — worker
// (chạy ngoài Next.js) ghi, dashboard đọc để hiện banner yêu cầu đăng nhập lại (npm run fb-login).
// Lỗi/thiếu row (migration chưa chạy) -> coi như OK thay vì throw, vì đây chỉ là banner phụ, không
// nên làm sập layout của cả app.
export async function getScraperStatus(): Promise<ScraperStatus> {
  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from('scraper_status')
    .select('session_expired, session_expired_at')
    .eq('key', 'global')
    .maybeSingle();
  if (error || !data) return { sessionExpired: false, sessionExpiredAt: null };
  return { sessionExpired: data.session_expired, sessionExpiredAt: data.session_expired_at };
}
