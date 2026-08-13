// Kiểu dữ liệu các bảng (hand-written thay cho `supabase gen types` vì không có live project lúc build).

export type CommentStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';

export interface FacebookPageRow {
  id: string;
  page_id: string;
  name: string;
  picture: string | null;
  access_token: string;
  token_expires_at: string | null;
  // Site WordPress đích của page này (null = dùng env mặc định) — xem lib/wordpress/site.ts
  wp_xmlrpc_url: string | null;
  wp_base_url: string | null;
  wp_category: string | null;
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
  comment_count: number | null; // tổng comment của bài — TÍNH CẢ comment của chính page
  reaction_count: number | null; // tổng reaction; null = chưa sync kể từ migration 0017 (khác hẳn 0)
  page_comment_at: string | null; // thời điểm page comment
  wp_dismissed_at: string | null; // đã bấm "Bỏ qua" ở /wp-needed (null = vẫn trong hàng đợi)
  raw: unknown;
  synced_at: string;
  created_at: string;
  // Bản backup ảnh FB (media_url) trên Supabase Storage — tải lúc sync (0023), vì link CDN của FB
  // hay hết hạn/chặn hotlink. Dùng làm ảnh đại diện khi "Tạo bài WP" từ caption FB.
  image_backup_url: string | null;
  image_backup_at: string | null; // đã thử backup chưa (set cả khi lỗi)
  image_backup_error: string | null;
}

export interface ScrapedArticleRow {
  id: string;
  post_id: string;
  source_url: string;
  title: string | null;
  wp_post_id: string | null;
  wp_status: string | null;
  wp_edit_url: string | null;
  wp_permalink: string | null; // link công khai (?p=ID khi còn draft)
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
// attempts có mặt để badge phân biệt "chờ lần đầu" với "đang chờ thử lại sau lỗi".
export type CommentHistoryRow = Pick<
  ScheduledCommentRow,
  | 'id'
  | 'post_id'
  | 'message'
  | 'attachment_url'
  | 'run_after'
  | 'status'
  | 'attempts'
  | 'sent_at'
  | 'error'
  | 'created_at'
>;

// =========================================================
// Theo dõi page đối thủ (cào Playwright, không có token Graph) — bảng 0007.
// =========================================================
export interface CompetitorPageRow {
  id: string;
  handle: string; // vanity (readfullstory2023) hoặc ID số
  fb_page_id: string | null;
  name: string | null;
  picture: string | null;
  kind: 'page' | 'profile';
  active: boolean;
  last_scraped_at: string | null;
  scrape_requested_at: string | null; // nút "Cào ngay" set = now(); worker poll thấy thì cào
  last_error: string | null;
  fail_count: number; // lượt lỗi LIÊN TIẾP; worker tự set active=false khi bị chặn hoặc đủ 3 lượt
  sheet_copied_at: string | null; // lần bấm "Copy bảng cho Sheet" gần nhất
  genre: string | null; // loại nội dung: 'Stories Ảnh' | 'Stories Video' | 'Video - Military' | …
  created_at: string;
  updated_at: string;
}

export interface CompetitorPostRow {
  id: string;
  competitor_page_id: string;
  fb_post_id: string;
  permalink: string | null;
  caption: string | null;
  caption_link_urls: string[]; // link bóc từ caption + attachment của bài (parse feed)
  comment_link_urls: string[]; // link bóc bằng cách mở permalink bài (nguồn chính của "full story")
  links_scanned_at: string | null; // null = chưa mở permalink bài này lần nào
  media_type: string | null;
  media_url: string | null;
  fb_created_at: string | null;
  raw: unknown;
  scraped_at: string;
  created_at: string;
  // Lần bài này được đưa vào bảng copy cho Sheet gần nhất (0018). NULL = chưa copy bao giờ.
  // Khác competitor_page.sheet_copied_at: cột kia là nhịp copy cả page trong ngày.
  sheet_copied_at: string | null;
  // Output Gemini đã tách sẵn (0009). Null = chưa bấm "Tạo prompt".
  story_analysis: string | null; // mục ### STORY ANALYSIS — tham khảo
  prompt_image: string | null; // mục ### IMAGE PROMPT
  prompt_video: string | null; // mục ### VIDEO PROMPT
  prompt_model: string | null;
  prompt_at: string | null;
  prompt_error: string | null;
  // prompt_raw CỐ Ý không có ở đây: rất dài, chỉ trả kèm trong response POST khi cần "Xem bản gốc".
  // Part 2 fallback do Gemini sinh từ caption (0022) — CHỈ dùng khi bài không có comment nào của
  // page (xem lib/part2.ts). part2_generated_at set cả khi lỗi, để worker khỏi retry vô hạn.
  part2_generated: string | null;
  part2_generated_at: string | null;
  part2_generated_error: string | null;
}

// Prompt gửi Gemini — sửa được trong app tại /prompts (0009 + 0022 + 0023).
// 'main' = mega-prompt ảnh/video (bài đối thủ). 'part2' = fallback sinh Part 2 khi bài đối thủ
// không có comment của page. 'wp_article' = sinh bài WordPress từ caption FB + Part 2 (bài mình).
export interface PromptTemplateRow {
  id: string;
  kind: 'main' | 'part2' | 'wp_article';
  label: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface CompetitorCommentRow {
  id: string;
  competitor_post_id: string;
  fb_comment_id: string | null;
  author_id: string | null;
  author_name: string | null;
  is_page_author: boolean; // comment của CHÍNH page (cột "Part 2") hay của người ngoài
  message: string | null;
  link_url: string | null; // = link_urls[0]; giữ cho UI/export cũ, dùng link_urls cho code mới
  link_urls: string[]; // MỌI URL bóc được từ text + entity/attachment của comment
  commented_at: string | null;
  scraped_at: string;
}
