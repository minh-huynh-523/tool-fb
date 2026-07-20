-- FB Post Dashboard — hàng đợi "Cần đăng link WP": bài đang có tương tác mà chưa có bài WordPress.
-- Chạy trong Supabase SQL editor TRƯỚC khi deploy code mới.
--
-- THỨ TỰ QUAN TRỌNG: sync.ts (bản mới) upsert cả `reaction_count`. Nếu deploy code trước khi
-- chạy migration này, PostgREST sẽ báo lỗi cột lạ trên MỌI lượt upsert -> pg_cron gọi mỗi phút
-- (migration 0005) sẽ fail liên tục, không chỉ mất mỗi reaction.

-- Tổng REACTION của bài (reactions.summary.total_count từ Graph — đã probe v25.0 thấy sống).
-- Lấy tổng reaction chứ không phải mỗi "like": nội dung dạng story thì love/sad/care chiếm phần
-- lớn, đếm mỗi like sẽ hụt đúng những bài đáng viết nhất.
--
-- NULL ≠ 0. NULL = chưa sync lần nào kể từ migration này (hoặc Graph không trả về);
-- 0 = đã sync và thật sự không ai thả. Query "cần đăng WP" so `> ngưỡng` nên NULL tự rớt khỏi
-- vế reaction mà không cần xử lý riêng — đúng ý: chưa biết thì đừng đoán.
alter table post add column if not exists reaction_count int;

-- "Đã quyết định KHÔNG viết bài WP cho bài này" (nút Bỏ qua ở /wp-needed).
-- Thiếu cột này thì hàng đợi thành cái loa hỏng: bài đã cân nhắc rồi vẫn nằm lại vĩnh viễn,
-- badge kẹt số dương và mất sạch ý nghĩa cảnh báo.
--
-- timestamptz thay vì boolean: biết bỏ qua lúc nào, hoàn tác được, và sau này muốn cho bài
-- "bùng lại" (tương tác tăng vọt sau khi bỏ qua) nổi lên lại thì đã có sẵn mốc để so.
alter table post add column if not exists wp_dismissed_at timestamptz;

-- Trang /wp-needed: bài ĐÃ ĐĂNG + chưa bỏ qua, sort display_time desc.
-- Ngưỡng reaction/comment CỐ Ý không nằm trong predicate — chúng đổi được lúc chạy (env
-- WP_ATTENTION_* + searchParams ?r=&c=), nhét vào đây là index chết ngay lần user chỉnh ngưỡng.
create index if not exists post_wp_attention_idx
  on post (display_time desc)
  where is_published and wp_dismissed_at is null;

-- KHÔNG cần index cho anti-join với scraped_article: post_id đã UNIQUE từ migration 0004,
-- unique index đó đủ cho NOT EXISTS.

-- KHÔNG backfill được reaction_count — số này chỉ có ở Graph, không nằm sẵn trong DB.
-- syncPage() mỗi lượt chỉ kéo 25 bài mới nhất/page và KHÔNG phân trang, nên bài cũ hơn sẽ giữ
-- NULL vô hạn (vô hình với vế reaction, vẫn hiện được qua vế comment).
-- Muốn phủ lịch sử: viết script phân trang qua paging.cursors.after rồi upsert onConflict fb_post_id.
