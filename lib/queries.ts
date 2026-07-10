import 'server-only';
import { createSupabaseAdmin } from './supabase/admin';
import { decryptToken } from './crypto';
import { getPostComments, type FbComment } from './facebook/client';
import type { CommentHistoryRow, CommentStatus, FacebookPageRow, PostRow, ScheduledCommentRow } from './types';

export type SafePage = Omit<FacebookPageRow, 'access_token'>;

// Cột tường minh — KHÔNG lấy `raw` (jsonb lớn, không render) để tránh over-fetch.
const POST_COLUMNS =
  'id, page_id, fb_post_id, message, permalink, media_type, media_url, fb_created_at, is_published, scheduled_publish_time, display_time, page_commented, comment_count, page_comment_at, synced_at, created_at';

export async function listPages(): Promise<SafePage[]> {
  const db = createSupabaseAdmin();
  const { data, error } = await db
    .from('facebook_page')
    .select('id, page_id, name, picture, token_expires_at, created_at, updated_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as SafePage[];
}

export interface PostWithComment extends PostRow {
  commentStatus: CommentStatus | null;
  commentCounts: Partial<Record<CommentStatus, number>>;
  comments: CommentHistoryRow[]; // lịch sử comment của mình cho bài này (mới lên lịch → đã đăng/lỗi)
  wp: { wp_post_id: string | null; wp_edit_url: string | null; wp_status: string | null } | null;
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
  // Đếm tổng (cùng bộ lọc) để phân trang.
  let countQ = db.from('post').select('id', { count: 'exact', head: true });
  if (filter.pageId) countQ = countQ.eq('page_id', filter.pageId);
  if (filter.status === 'PUBLISHED') countQ = countQ.eq('is_published', true);
  if (filter.status === 'SCHEDULED') countQ = countQ.eq('is_published', false);
  if (filter.from) countQ = countQ.gte('display_time', filter.from);
  if (filter.to) countQ = countQ.lte('display_time', filter.to);
  if (filter.uncommented) countQ = countQ.eq('page_commented', false);
  const { count } = await countQ;
  const total = count ?? 0;

  // Lấy dữ liệu trang hiện tại.
  const offset = (page - 1) * pageSize;
  let dataQ = db
    .from('post')
    .select(POST_COLUMNS)
    .order('display_time', { ascending: false, nullsFirst: false })
    .range(offset, offset + pageSize - 1);
  if (filter.pageId) dataQ = dataQ.eq('page_id', filter.pageId);
  if (filter.status === 'PUBLISHED') dataQ = dataQ.eq('is_published', true);
  if (filter.status === 'SCHEDULED') dataQ = dataQ.eq('is_published', false);
  if (filter.from) dataQ = dataQ.gte('display_time', filter.from);
  if (filter.to) dataQ = dataQ.lte('display_time', filter.to);
  if (filter.uncommented) dataQ = dataQ.eq('page_commented', false);

  const { data: posts, error } = await dataQ;
  if (error) throw error;
  const list = (posts ?? []) as PostRow[];
  if (!list.length) return { rows: [], total, page, pageSize };

  // Lịch sử comment (của mình) cho các post của trang hiện tại — vừa để đếm badge, vừa để
  // mở bảng "comment đã lên lịch" ngay trong dòng. Sắp theo giờ hẹn (cũ → mới).
  const ids = list.map((p) => p.id);
  const { data: comments } = await db
    .from('scheduled_comment')
    .select('id, post_id, message, attachment_url, run_after, status, sent_at, error, created_at')
    .in('post_id', ids)
    .order('run_after', { ascending: true });

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

  // Bài WordPress đã tạo (nếu có) cho các post của trang hiện tại.
  const { data: scraped } = await db
    .from('scraped_article')
    .select('post_id, wp_post_id, wp_edit_url, wp_status')
    .in('post_id', ids);
  const wpByPost = new Map<string, PostWithComment['wp']>();
  for (const s of (scraped ?? []) as {
    post_id: string;
    wp_post_id: string | null;
    wp_edit_url: string | null;
    wp_status: string | null;
  }[]) {
    wpByPost.set(s.post_id, { wp_post_id: s.wp_post_id, wp_edit_url: s.wp_edit_url, wp_status: s.wp_status });
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
  scraped: { wp_post_id: string | null; wp_edit_url: string | null; wp_status: string | null } | null;
} | null> {
  const db = createSupabaseAdmin();
  const { data: post, error } = await db.from('post').select(POST_COLUMNS).eq('id', postDbId).maybeSingle();
  if (error) throw error;
  if (!post) return null;
  const { data: comments } = await db
    .from('scheduled_comment')
    .select('*')
    .eq('post_id', postDbId)
    .order('created_at', { ascending: false });
  const { data: scraped } = await db
    .from('scraped_article')
    .select('wp_post_id, wp_edit_url, wp_status')
    .eq('post_id', postDbId)
    .maybeSingle();
  return {
    post: post as PostRow,
    comments: (comments ?? []) as ScheduledCommentRow[],
    scraped: (scraped as { wp_post_id: string | null; wp_edit_url: string | null; wp_status: string | null }) ?? null,
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
