-- FB Post Dashboard — thêm 5 page đối thủ đợt 2 vào danh sách cào.
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
--
-- handle: với URL profile.php?id=<n> thì handle = <n> (worker tự dựng lại URL profile.php),
-- với URL vanity thì handle = phần sau facebook.com/. Xem pageUrl() trong lib/fb-scraper/client.ts.
--
-- active=true: chưa biết page nào bị geo-block IP VN. Chạy worker 1 lượt, page nào ghi
-- last_error kiểu "Bị chặn…" thì set active=false rồi bật lại khi có VPN (giống 9 page ở 0007).
--
-- Ghi chú thể loại của user (KHÔNG có cột lưu — để đây làm tài liệu):
--   Oliver's Open Minds Collective  — Stories Ảnh
--   Pacas De Ropa Americana …       — Video - Military
--   US Family Stories               — Stories Ảnh
--   Stories She Carries             — Video - Military
--   Raw Confessions                 — Video - Military

insert into competitor_page (handle, fb_page_id, name, kind, active) values
  ('61570520710170', '61570520710170', 'Oliver''s Open Minds Collective',              'page', true),
  ('pacaropaamerica', null,            'Pacas De Ropa Americana Bonita Y De Calidad',  'page', true),
  ('61590709580729', '61590709580729', 'US Family Stories',                            'page', true),
  ('61585811426239', '61585811426239', 'Stories She Carries',                          'page', true),
  ('rawconfessions22', null,           'Raw Confessions',                              'page', true)
on conflict (handle) do nothing;
