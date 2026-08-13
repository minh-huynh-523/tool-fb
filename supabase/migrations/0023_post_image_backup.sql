-- FB Post Dashboard — backup ảnh FB của bài MÌNH vào Supabase Storage + sinh bài WordPress từ
-- chính caption FB (thay vì phải dán link bài ngoài để cào)
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
--
-- Ảnh FB (post.media_url) là link CDN của Facebook — hay hết hạn/bị chặn hotlink khi fetch server-
-- side. Thay vì tải lại mỗi lần cần (lúc bấm "Tạo bài WP"), tải MỘT LẦN ngay lúc sync (kéo bài từ
-- FB Graph API, xem lib/sync.ts) rồi lưu bản sao bền vào Supabase Storage — dùng lại được bất cứ
-- lúc nào, kể cả khi link FB gốc đã chết.

-- =========================================================
-- 1) Storage bucket chứa bản backup ảnh — public (ảnh vốn đã công khai trên FB)
-- =========================================================
insert into storage.buckets (id, name, public)
values ('post-media', 'post-media', true)
on conflict (id) do nothing;

-- =========================================================
-- 2) post — thêm cột lưu kết quả backup ảnh
-- =========================================================
alter table post
  add column if not exists image_backup_url   text,        -- URL public trên Supabase Storage
  add column if not exists image_backup_at    timestamptz, -- đã thử backup chưa (set cả khi lỗi, tránh retry vô hạn)
  add column if not exists image_backup_error text;        -- lỗi lần backup gần nhất (nếu có)

create index if not exists post_image_backup_idx
  on post (image_backup_at desc nulls last);

-- =========================================================
-- 3) prompt_template — thêm kind='wp_article', SỬA ĐƯỢC TRONG APP
--    (bảng đã tồn tại từ migration 0009)
-- =========================================================
-- Tiêu đề KHÔNG do Gemini đặt — app tự lấy nguyên văn đoạn mở đầu của caption gốc làm tiêu đề
-- (xem firstParagraph() trong lib/wp-article-gen.ts), vì model hay diễn giải lại dù có dặn kỹ.
-- Prompt dưới đây CHỈ có nhiệm vụ viết phần NỘI DUNG bài viết.
insert into prompt_template (kind, label, body) values
  ('wp_article', 'Bài WordPress từ caption FB + Part 2', $prompt$Bạn sẽ nhận 1 caption bài Facebook và (có thể có) phần "Part 2" là bình luận nối tiếp câu chuyện.
Viết lại thành 1 bài viết hoàn chỉnh cho blog, giữ đúng sự thật/chi tiết đã có, KHÔNG bịa thêm tình
tiết trái ngược. Viết bằng cùng ngôn ngữ với caption gốc.

CHỈ trả về nội dung bài viết dạng HTML, chia đoạn bằng thẻ <p>...</p>. KHÔNG thêm tiêu đề, heading,
markdown, hay lời dẫn nào khác — tiêu đề đã được lấy sẵn từ đoạn mở đầu của caption gốc, đừng mở đầu
nội dung bằng cách lặp lại y nguyên đoạn đó nếu không cần thiết.

Caption gốc:
{{caption}}

Part 2 (nếu có):
{{part2}}
$prompt$)
on conflict (kind) do nothing;
