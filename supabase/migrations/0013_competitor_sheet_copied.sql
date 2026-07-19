-- FB Post Dashboard — nhớ page nào đã copy sang Sheet rồi.
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
--
-- Lưu ở DB chứ không phải localStorage: mở máy khác / trình duyệt khác vẫn phải thấy đúng,
-- và đây là thứ dễ copy trùng nhất khi có nhiều page.
--
-- Ý nghĩa: mốc lần bấm "Copy bảng cho Sheet" gần nhất. So với giờ đăng của bài mới nhất để
-- biết đã copy xong hay lại có bài mới chưa copy (xem sheetState() trong lib/queries.ts).

alter table competitor_page
  add column if not exists sheet_copied_at timestamptz;
