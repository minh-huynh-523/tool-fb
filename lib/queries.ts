import 'server-only';
import { createSupabaseAdmin } from './supabase/admin';
import { decryptToken } from './crypto';
import { getPostComments, type FbComment } from './facebook/client';
import type {
  CommentHistoryRow,
  CommentStatus,
  CompetitorCommentRow,
  CompetitorPageRow,
  CompetitorPostRow,
  FacebookPageRow,
  PostRow,
  ScheduledCommentRow,
} from './types';

export type SafePage = Omit<FacebookPageRow, 'access_token'>;

// Cột tường minh — KHÔNG lấy `raw` (jsonb lớn, không render) để tránh over-fetch.
const POST_COLUMNS =
  'id, page_id, fb_post_id, message, permalink, media_type, media_url, fb_created_at, is_published, scheduled_publish_time, display_time, page_commented, comment_count, page_comment_at, synced_at, created_at';

export async function listPages(): Promise<SafePage[]> {
  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from('facebook_page')
    .select('id, page_id, name, picture, token_expires_at, wp_xmlrpc_url, wp_base_url, wp_category, created_at, updated_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as SafePage[];
}

export interface PostWithComment extends PostRow {
  commentStatus: CommentStatus | null;
  commentCounts: Partial<Record<CommentStatus, number>>;
  comments: CommentHistoryRow[]; // lịch sử comment của mình cho bài này (mới lên lịch → đã đăng/lỗi)
  wp: { wp_post_id: string | null; wp_edit_url: string | null; wp_status: string | null; wp_permalink: string | null } | null;
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

export interface PostFilter {
  pageId?: string;
  status?: 'PUBLISHED' | 'SCHEDULED';
  from?: string; // ISO — lọc display_time >=
  to?: string; // ISO — lọc display_time <=
  uncommented?: boolean;
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
  let dataQ = db
    .from('post')
    .select(POST_COLUMNS, { count: 'exact' })
    .order('display_time', { ascending: false, nullsFirst: false })
    .range(offset, offset + pageSize - 1);
  if (filter.pageId) dataQ = dataQ.eq('page_id', filter.pageId);
  if (filter.status === 'PUBLISHED') dataQ = dataQ.eq('is_published', true);
  if (filter.status === 'SCHEDULED') dataQ = dataQ.eq('is_published', false);
  if (filter.from) dataQ = dataQ.gte('display_time', filter.from);
  if (filter.to) dataQ = dataQ.lte('display_time', filter.to);
  if (filter.uncommented) dataQ = dataQ.eq('page_commented', false);

  const { data: posts, count, error } = await dataQ;
  if (error) throw error;
  const total = count ?? 0;
  const list = (posts ?? []) as PostRow[];
  if (!list.length) return { rows: [], total, page, pageSize };

  // Lịch sử comment (của mình) + bài WP cho các post của trang hiện tại — 2 query độc lập,
  // chạy SONG SONG để tiết kiệm 1 round-trip Supabase.
  const ids = list.map((p) => p.id);
  const [{ data: comments }, { data: scraped }] = await Promise.all([
    db
      .from('scheduled_comment')
      .select('id, post_id, message, attachment_url, run_after, status, sent_at, error, created_at')
      .in('post_id', ids)
      .order('run_after', { ascending: true }),
    db.from('scraped_article').select('post_id, wp_post_id, wp_edit_url, wp_status, wp_permalink').in('post_id', ids),
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
  }[]) {
    wpByPost.set(s.post_id, {
      wp_post_id: s.wp_post_id,
      wp_edit_url: s.wp_edit_url,
      wp_status: s.wp_status,
      wp_permalink: resolvePermalink(s),
    });
  }

  const rows: PostWithComment[] = list.map((p) => {
    const counts = byPost.get(p.id) ?? {};
    return {
      ...p,
      commentStatus: summarize(counts),
      commentCounts: counts,
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
  } | null;
} | null> {
  const db = createSupabaseAdmin();
  // 3 query độc lập (cùng key postDbId) — chạy song song, tiết kiệm 2 round-trip.
  const [{ data: post, error }, { data: comments }, { data: scraped }] = await Promise.all([
    db.from('post').select(POST_COLUMNS).eq('id', postDbId).maybeSingle(),
    db.from('scheduled_comment').select('*').eq('post_id', postDbId).order('created_at', { ascending: false }),
    db
      .from('scraped_article')
      .select('wp_post_id, wp_edit_url, wp_status, wp_permalink')
      .eq('post_id', postDbId)
      .maybeSingle(),
  ]);
  if (error) throw error;
  if (!post) return null;
  const s = scraped as {
    wp_post_id: string | null;
    wp_edit_url: string | null;
    wp_status: string | null;
    wp_permalink: string | null;
  } | null;
  return {
    post: post as PostRow,
    comments: (comments ?? []) as ScheduledCommentRow[],
    scraped: s ? { ...s, wp_permalink: resolvePermalink(s) } : null,
  };
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
}

export async function listCompetitorPages(): Promise<CompetitorPageWithCount[]> {
  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from('competitor_page')
    .select('*, competitor_post(count)')
    .order('active', { ascending: false })
    .order('name', { ascending: true, nullsFirst: false });
  if (error) throw error;
  // Supabase trả competitor_post: [{ count }] -> phẳng thành post_count.
  return (data ?? []).map((r) => {
    const { competitor_post, ...rest } = r as CompetitorPageRow & { competitor_post?: Array<{ count: number }> };
    return { ...rest, post_count: competitor_post?.[0]?.count ?? 0 } as CompetitorPageWithCount;
  });
}

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
    .select('*, competitor_comment(*)')
    .eq('competitor_page_id', id)
    .order('fb_created_at', { ascending: false, nullsFirst: false })
    .order('scraped_at', { ascending: false });

  const mapped = (posts ?? []).map((p) => {
    const { competitor_comment, ...rest } = p as CompetitorPostRow & { competitor_comment?: CompetitorCommentRow[] };
    return { ...rest, comments: competitor_comment ?? [] } as CompetitorPostWithComments;
  });
  return { page: page as CompetitorPageRow, posts: mapped };
}
