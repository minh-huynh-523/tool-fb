// Kiểu dữ liệu các bảng (hand-written thay cho `supabase gen types` vì không có live project lúc build).

export type CommentStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';

export interface FacebookPageRow {
  id: string;
  page_id: string;
  name: string;
  picture: string | null;
  access_token: string;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostRow {
  id: string;
  page_id: string;
  fb_post_id: string;
  message: string | null;
  permalink: string | null;
  media_type: string | null;
  media_url: string | null;
  fb_created_at: string | null;
  is_published: boolean;
  scheduled_publish_time: string | null; // chỉ có ở bài đang lên lịch
  display_time: string | null; // coalesce(scheduled_publish_time, fb_created_at) — dùng để sort/lọc
  page_commented: boolean; // page đã tự comment bài này chưa (từ FB thật)
  comment_count: number | null; // tổng comment của bài
  page_comment_at: string | null; // thời điểm page comment
  raw: unknown;
  synced_at: string;
  created_at: string;
}

export interface ScrapedArticleRow {
  id: string;
  post_id: string;
  source_url: string;
  title: string | null;
  wp_post_id: string | null;
  wp_status: string | null;
  wp_edit_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledCommentRow {
  id: string;
  post_id: string;
  fb_post_id: string;
  page_id: string;
  message: string;
  attachment_url: string | null;
  run_after: string;
  status: CommentStatus;
  attempts: number;
  claimed_at: string | null;
  fb_comment_id: string | null;
  error: string | null;
  sent_at: string | null;
  created_at: string;
}

// Subset của scheduled_comment để hiển thị nhanh lịch sử "comment của mình" trong bảng post.
export type CommentHistoryRow = Pick<
  ScheduledCommentRow,
  'id' | 'post_id' | 'message' | 'attachment_url' | 'run_after' | 'status' | 'sent_at' | 'error' | 'created_at'
>;
