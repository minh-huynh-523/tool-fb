-- FB Post Dashboard — nhớ ĐÃ COPY SANG SHEET NHỮNG BÀI NÀO của đối thủ (trước đây chỉ nhớ ở
-- cấp page: competitor_page.sheet_copied_at từ migration 0013).
--
-- Vì sao cần cấp bài: mốc ở cấp page chỉ trả lời "hôm nay copy chưa", KHÔNG trả lời được
-- "bài này đã copy lần nào chưa". Cào 6h/lần nên hai lượt cào liền nhau chồng lấn nhau rất
-- nhiều bài — copy theo cửa sổ 6h là dán trùng vào Sheet, phải tự dò tay mà xoá.
--
-- Chạy trong Supabase SQL editor.

-- Mốc lần bài này được đưa vào bảng copy gần nhất. NULL = chưa copy bao giờ.
-- timestamptz thay boolean: biết copy lúc nào để đối chiếu với Sheet khi nghi dán thiếu/thừa,
-- và bỏ đánh dấu chỉ là set về NULL.
alter table competitor_post
  add column if not exists sheet_copied_at timestamptz;

-- Truy vấn nóng: "bài của page X chưa copy, mới nhất trước" — đúng tập mà nút Copy lấy mặc định.
-- Partial index (chỉ hàng chưa copy) vì bài đã copy sẽ chiếm đa số theo thời gian và không bao
-- giờ nằm trong tập mặc định nữa.
create index if not exists competitor_post_uncopied_idx
  on competitor_post (competitor_page_id, fb_created_at desc)
  where sheet_copied_at is null;

-- KHÔNG backfill: không có cách nào biết bài cũ đã từng nằm trong lần dán nào.
-- Đánh dấu bừa theo competitor_page.sheet_copied_at sẽ giấu mất bài thật sự chưa copy —
-- thà để NULL (hiện "chưa copy") rồi user tự bỏ qua, còn hơn im lặng bỏ sót.
-- competitor_page.sheet_copied_at GIỮ NGUYÊN: nó phục vụ badge nhịp-làm-việc-trong-ngày
-- (sheetState) — khác câu hỏi với cột này.
