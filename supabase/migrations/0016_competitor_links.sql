-- Bóc MỌI link trong caption + comment của page đối thủ (trước đây chỉ lấy 1 link, chỉ ở comment).
--
-- Vì sao cần: 201 comment đã cào chỉ 30 cái có link_url — đúng 30 cái có URL dạng chữ thường trong
-- message. 162 comment còn lại NÓI THẲNG là có link ("tap the line of blue text") nhưng URL không
-- nằm trong body.text nên regex cũ không thấy. Thêm nữa caption chưa từng được bóc link lần nào.

-- Nhiều link / 1 comment. link_url (1 link) giữ nguyên để UI + export cũ không vỡ trong lúc chuyển.
alter table competitor_comment
  add column if not exists link_urls text[] not null default '{}';

-- Lưu cả comment của NGƯỜI NGOÀI (trước lọc bỏ ngay lúc parse). Link "full story" hay được thả từ
-- profile cá nhân của admin — lọc theo tác giả là vứt luôn cả link.
alter table competitor_comment
  add column if not exists author_id text,
  add column if not exists is_page_author boolean not null default true;

-- Link bóc từ caption + attachment của chính bài (đường parse feed).
alter table competitor_post
  add column if not exists caption_link_urls text[] not null default '{}';

-- Link bóc bằng cách MỞ PERMALINK từng bài. Đây mới là đường lấy được link "full story":
-- đã dump fragment GraphQL của feed 2 lượt, không hề có comment node mang link. Mở đúng trang bài
-- thì link hiện trong DOM dạng bọc l.facebook.com/l.php?u=…
alter table competitor_post
  add column if not exists comment_link_urls text[] not null default '{}';

-- Mốc đã quét permalink. NULL = chưa quét bao giờ. Cần cột riêng chứ không suy từ
-- comment_link_urls rỗng: "đã quét, không có link" khác hẳn "chưa quét" — thiếu nó thì mỗi lượt
-- sẽ quét lại vô tận mấy bài không bao giờ có link.
alter table competitor_post
  add column if not exists links_scanned_at timestamptz;

-- Chọn bài cần quét: chưa quét bao giờ (thứ tự bài mới trước).
create index if not exists competitor_post_links_unscanned_idx
  on competitor_post (fb_created_at desc)
  where links_scanned_at is null;

-- Backfill: đưa link_url cũ vào mảng để UI mới đọc được ngay, không cần chờ cào lại.
update competitor_comment
set link_urls = array[link_url]
where link_url is not null and link_url <> '' and link_urls = '{}';

-- is_page_author default true là ĐÚNG cho dữ liệu cũ: mọi hàng đang có đều đã qua bộ lọc
-- "chỉ comment của page", nên cột "Part 2" giữ nguyên nội dung sau migration.

-- Lọc nhanh comment có link khi thống kê độ phủ.
create index if not exists competitor_comment_has_link_idx
  on competitor_comment (competitor_post_id)
  where link_urls <> '{}';
