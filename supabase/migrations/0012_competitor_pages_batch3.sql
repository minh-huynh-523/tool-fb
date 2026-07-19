-- FB Post Dashboard — thêm 7 page đối thủ đợt 3.
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
--
-- Cả 7 đã test bằng `npm run worker:dry <handle>` từ IP VN: cào được, không cần VPN → active=true.
-- Tên lấy đúng như FB trả về (chú ý "Kindness Story", không phải "Kindness Storey").
--
-- Ghi chú thể loại của user (KHÔNG có cột lưu — để đây làm tài liệu):
--   The Daily Tale           — Stories Video
--   Kindness Story           — Stories Ảnh
--   Joker Joker              — Stories Video
--   The Weekly Brief         — Stories Ảnh
--   Yova Nika                — Video - Military
--   Back in Our Antique Days — (user chưa ghi thể loại)
--   Buzz Network             — Stories Ảnh
--
-- kind='profile' cho 2 handle bắt đầu bằng "100" (tài khoản cá nhân, không phải page).

insert into competitor_page (handle, fb_page_id, name, kind, active) values
  ('61589613419208',  '61589613419208',  'The Daily Tale',           'page',    true),
  ('61585369480106',  '61585369480106',  'Kindness Story',           'page',    true),
  ('61556117223399',  '61556117223399',  'Joker Joker',              'page',    true),
  ('61550594455271',  '61550594455271',  'The Weekly Brief',         'page',    true),
  ('yovanika22',      null,              'Yova Nika',                'page',    true),
  ('100083841985996', '100083841985996', 'Back in Our Antique Days', 'profile', true),
  ('100094562303880', '100094562303880', 'Buzz Network',             'profile', true)
on conflict (handle) do nothing;
