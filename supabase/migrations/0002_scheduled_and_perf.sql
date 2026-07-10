-- FB Post Dashboard — bổ sung bài lên lịch + index cho performance
-- Chạy: supabase db push  (hoặc dán vào Supabase SQL editor)

-- =========================================================
-- 1) post: thêm trạng thái publish + thời gian hiển thị thống nhất
-- =========================================================
-- is_published = false  => bài đang lên lịch (chưa lên sóng)
alter table post add column if not exists is_published boolean not null default true;
-- scheduled_publish_time: giờ FB sẽ đăng (chỉ có ở bài lên lịch)
alter table post add column if not exists scheduled_publish_time timestamptz;
-- display_time: mốc thời gian dùng để sort/lọc thống nhất
--   bài lên lịch -> scheduled_publish_time ; bài đã đăng -> fb_created_at
alter table post add column if not exists display_time timestamptz;

-- backfill cho dữ liệu cũ (toàn bộ đang là bài đã đăng)
update post
set display_time = coalesce(scheduled_publish_time, fb_created_at)
where display_time is null;

-- =========================================================
-- 2) Index cho view mặc định (sort theo display_time desc, có/không lọc trạng thái)
--    Cũng khắc phục việc sort toàn cục trước đây không có index phù hợp.
-- =========================================================
create index if not exists post_display_time_idx on post (display_time desc);
create index if not exists post_pub_display_idx  on post (is_published, display_time desc);
