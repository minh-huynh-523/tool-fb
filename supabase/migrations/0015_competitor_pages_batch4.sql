-- FB Post Dashboard — thêm page đối thủ đợt 4.
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
--
-- Cả 4 đã test `npm run worker:dry <handle>` từ IP VN, đều cào được, không cần VPN:
--   Silent Showdowns      10 bài, mới nhất 0.1h
--   Gain and loss         10 bài, mới nhất 1.3h
--   Twist Of Fate Stories  7 bài, mới nhất 0.3h
--   Life In The Heartland  1 bài, mới nhất 0.1h  (page mới lập? theo dõi thêm vài lượt cào)
--
-- CHẠY SAU 0014 — file này dùng cột genre do 0014 tạo ra.

insert into competitor_page (handle, fb_page_id, name, kind, active, genre) values
  ('61581246046687', '61581246046687', 'Silent Showdowns',      'page', true, 'Video - Military'),
  ('61591355156402', '61591355156402', 'Gain and loss',         'page', true, 'Video - Military'),
  ('61566668105174', '61566668105174', 'Twist Of Fate Stories', 'page', true, 'Video - Military'),
  ('61586831068521', '61586831068521', 'Life In The Heartland', 'page', true, 'Video - Military')
on conflict (handle) do nothing;
