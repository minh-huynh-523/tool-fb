-- Backfill Part 2 comment cho bài ĐÃ cào từ trước (links_scanned_at đã set).
--
-- lib/fb-scraper: post-links.ts + worker.ts giờ lấy thêm comment (Part 2) mỗi khi mở permalink
-- một bài, ăn ké đúng lượt quét link đã có sẵn. Nhưng bài nào ĐÃ quét link từ trước khi tính năng
-- này tồn tại (links_scanned_at không NULL) thì `due` query hiện tại (worker.ts scrapePostLinks)
-- không bao giờ mở lại permalink của nó nữa — nếu đã ra link thì loại vĩnh viễn, nếu quá cũ
-- (> postLinkRescanHours) cũng loại — nên Part 2 của cả đống bài cũ không bao giờ được lấy.
--
-- Cột riêng thay vì tái dùng links_scanned_at: 2 việc (quét link / lấy comment) có vòng đời khác
-- nhau — 1 bài có thể đã "chốt" xong phần link (không rescan nữa) nhưng vẫn cần 1 lượt riêng để lấy
-- comment lần đầu. Tách cột thì worker.ts mở rộng due-query mà không đụng logic link hiện có.

alter table competitor_post
  add column if not exists comments_scanned_at timestamptz;

-- Chọn nhanh bài cần backfill comment (đã quét link nhưng chưa quét comment), mới nhất trước.
create index if not exists competitor_post_comments_unscanned_idx
  on competitor_post (fb_created_at desc)
  where comments_scanned_at is null;
