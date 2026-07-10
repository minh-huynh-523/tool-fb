-- FB Post Dashboard — trạng thái comment THẬT từ Facebook (page đã comment bài chưa)
-- Chạy: supabase db push (hoặc dán vào Supabase SQL editor)

-- page_commented = true nếu trên bài đã có comment do CHÍNH PAGE đăng (from.id == page_id).
alter table post add column if not exists page_commented boolean not null default false;
-- Tổng số comment của bài (comments.summary.total_count từ Graph).
alter table post add column if not exists comment_count int;
-- Thời điểm page comment (created_time của comment đầu tiên do page đăng) — để hiển thị.
alter table post add column if not exists page_comment_at timestamptz;

-- Lọc nhanh "bài page chưa comment".
create index if not exists post_page_commented_idx on post (page_commented, display_time desc);
