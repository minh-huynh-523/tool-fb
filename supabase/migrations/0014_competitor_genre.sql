-- FB Post Dashboard — thêm "loại" cho page đối thủ (Stories Ảnh / Stories Video / Video - Military).
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
--
-- Trước đây loại chỉ nằm trong comment của migration 0010/0012 → không lọc, không hiện được.
-- Để text tự do thay vì enum: danh sách loại còn đang thay đổi, thêm loại mới không phải
-- sửa schema. UI đọc thẳng giá trị này.

alter table competitor_page
  add column if not exists genre text;

-- Điền loại theo ghi chú user đã gửi (0010 + 0012).
-- LƯU Ý: Pacas De Ropa Americana / Raw Confessions / Yova Nika ban đầu user ghi là
-- Video - Military, nhưng sau đó chốt lại chỉ 5 page ở 0015 mới thuộc loại đó → 3 page này
-- chuyển sang Stories Video.
update competitor_page set genre = 'Stories Ảnh'      where handle = '61570520710170';  -- Oliver's Open Minds Collective
update competitor_page set genre = 'Stories Video'    where handle = 'pacaropaamerica';  -- Pacas De Ropa Americana
update competitor_page set genre = 'Stories Ảnh'      where handle = '61590709580729';  -- US Family Stories
update competitor_page set genre = 'Video - Military' where handle = '61585811426239';  -- Stories She Carries
update competitor_page set genre = 'Stories Video'    where handle = 'rawconfessions22'; -- Raw Confessions
update competitor_page set genre = 'Stories Video'    where handle = '61589613419208';  -- The Daily Tale
update competitor_page set genre = 'Stories Ảnh'      where handle = '61585369480106';  -- Kindness Story
update competitor_page set genre = 'Stories Video'    where handle = '61556117223399';  -- Joker Joker
update competitor_page set genre = 'Stories Ảnh'      where handle = '61550594455271';  -- The Weekly Brief
update competitor_page set genre = 'Stories Video'    where handle = 'yovanika22';      -- Yova Nika
update competitor_page set genre = 'Stories Ảnh'      where handle = '100094562303880'; -- Buzz Network

-- Số còn lại user chốt là Stories Video. Gồm: Overland Voices, The Story Beyond,
-- Vault of Stories, Back in Our Antique Days + 7 page seed chưa cào được tên (0007).
-- Dùng `where genre is null` nên chạy lại file này cũng không đè lên loại đã gán ở trên.
update competitor_page set genre = 'Stories Video' where genre is null;
