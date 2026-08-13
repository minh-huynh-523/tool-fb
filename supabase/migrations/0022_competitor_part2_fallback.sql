-- FB Post Dashboard — Part 2 fallback sinh bằng Gemini khi bài đối thủ không có comment của page
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
--
-- "Part 2" trước giờ = comment do CHÍNH page đối thủ đăng dưới bài, cào ở lượt permalink
-- (scrapePostLinks). Nhiều bài không bao giờ có comment như vậy -> Part 2 bỏ trống, không dùng
-- được cho mega-prompt/Sheet export. Giờ: worker cào xong lượt permalink (biết chắc bài có comment
-- của page hay không), bài nào không có thì gọi Gemini sinh 1 "Part 2" từ caption, có CTA mời
-- comment để dẫn dắt viral — CHỈ dùng khi thật sự thiếu, không đè lên comment thật cào được.
-- RLS default-deny như các bảng khác (chỉ service_role đọc/ghi).

-- =========================================================
-- 1) competitor_post — thêm cột chứa Part 2 do Gemini sinh
-- =========================================================
alter table competitor_post
  add column if not exists part2_generated      text,        -- Part 2 do Gemini sinh từ caption
  add column if not exists part2_generated_at    timestamptz, -- đã thử sinh chưa (set cả khi lỗi, tránh retry vô hạn)
  add column if not exists part2_generated_error text;        -- lỗi lần sinh gần nhất (nếu có)

create index if not exists competitor_post_part2_generated_idx
  on competitor_post (part2_generated_at desc nulls last);

-- =========================================================
-- 2) prompt_template — thêm kind='part2', SỬA ĐƯỢC TRONG APP
--    (bảng đã tồn tại từ migration 0009, giờ dùng đúng chỗ để ngỏ 'không phải chỉ 1 kind')
-- =========================================================
insert into prompt_template (kind, label, body) values
  ('part2', 'Part 2 fallback (khi bài không có comment của page)', $prompt$Bạn sẽ nhận một caption bài Facebook. Viết tiếp một đoạn "Part 2" NGẮN (2-4 câu), giữ đúng giọng
kể chuyện/drama của caption gốc, tạo cảm giác còn nhiều chuyện chưa kể, và kết thúc bằng ĐÚNG dòng
CTA sau (giữ nguyên, không đổi chữ):

Comment "YES" for full story 👇

Yêu cầu:
* Chỉ trả về đúng đoạn văn Part 2 (kèm dòng CTA ở cuối) — không thêm heading, không giải thích,
  không nhắc lại caption gốc.
* Viết bằng cùng ngôn ngữ với caption gốc.
* Không bịa thêm chi tiết trái ngược caption gốc — chỉ khơi gợi tò mò về phần tiếp theo.

Caption gốc:
{{caption}}
$prompt$)
on conflict (kind) do nothing;
