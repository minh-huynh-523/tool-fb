-- FB Post Dashboard — nốt cron cuối cùng còn chạm Vercel: fb-dashboard-sync (jobid 3, migration
-- 0005) vẫn đang gọi https://tool-fb-klta.vercel.app/api/cron/sync-pages. Repoint sang Edge
-- Function sync-pages (supabase/functions/sync-pages) — cùng lý do với wp-content/wp-publish
-- (migration 0025): không tốn quota Fluid Compute của Vercel nữa. Vercel giờ CHỈ còn phục vụ UI +
-- vài route proxy mỏng (session check -> gọi HTTP vào các Edge Function này).
--
-- Thêm 1 job MỚI fb-dashboard-process-comments — an toàn lưới rút hàng đợi scheduled_comment
-- CHUNG (mọi comment, không chỉ "Full story" của auto-publish), độc lập với sync-pages: trước đây
-- là route Vercel process-comments, gọi bởi cron-job.org (ngoài tầm kiểm soát của migration này —
-- job cron-job.org đó cần tắt tay sau khi deploy xong, xem PR).
--
-- ⚠️ BÀI HỌC từ chính lần deploy migration này (không phải chuyện cũ): file 0025 gốc commit
-- <PROJECT_REF>/<SERVICE_ROLE_KEY> làm placeholder, dặn "thay giá trị thật rồi chạy tay trong SQL
-- Editor". Đúng lúc đang set giá trị thật cho job này thì có 1 lượt SOMETHING (chưa xác định được
-- nguồn — nghi ngờ hàng đầu: 1 tiến trình theo dõi thư mục supabase/migrations/ và tự
-- `supabase db push` khi thấy file mới) ÂM THẦM chạy lại đúng file 0026 bản Ổ ĐĨA (kèm
-- placeholder) đè lên giá trị thật vừa set — job fb-dashboard-sync fail 1 lượt (17:30 UTC) và
-- job process-comments bị unschedule+reschedule sang jobid mới. Tức là "commit placeholder, áp
-- giá trị thật ngoài band" (cách 0025 làm) KHÔNG AN TOÀN trong môi trường này — bất kỳ ai/thứ gì
-- áp lại file từ ổ đĩa cũng sẽ phá giá trị thật.
--
-- FIX CẤU TRÚC: dùng Supabase Vault để lưu service_role key TRONG DATABASE — file migration này
-- (và toàn bộ SQL bên dưới) KHÔNG chứa bất kỳ secret nào, nên áp lại bao nhiêu lần cũng an toàn,
-- không cần "chạy tay thay placeholder" nữa.
--
-- ⚠️ BƯỚC THỦ CÔNG 1 LẦN (không nằm trong file này, vì cần giá trị secret thật):
--   select vault.create_secret(
--     '<SERVICE_ROLE_KEY thật>',
--     'fb_dashboard_edge_bearer',
--     'service_role key dùng bởi pg_cron để gọi Edge Function của project này'
--   );
-- Chạy 1 lần trong SQL Editor (hoặc qua Management API) — sau đó KHÔNG cần đụng lại, mọi cron job
-- bên dưới tự đọc lại từ vault.decrypted_secrets mỗi lần chạy.
--
-- Trước khi chạy phần cron.schedule/alter_job bên dưới: đã deploy đủ 2 Edge Function mới
--   supabase functions deploy sync-pages
--   supabase functions deploy process-comments
-- Không cần secret Edge Function mới — sync-pages/process-comments dùng lại đúng bộ đã set cho
-- wp-content/wp-publish (FACEBOOK_APP_SECRET, FACEBOOK_GRAPH_VERSION, TOKEN_ENC_KEY).

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- sync-pages chạy hết ~55s với 8 page thật (đã đo) — timeout rộng hơn 0025 (55s) để không cắt
-- ngang khi có thêm page/bài trong tương lai.
select cron.alter_job(
  3, -- jobid của fb-dashboard-sync (migration 0005)
  command => $$
  select net.http_post(
    url := 'https://wevdllaqnypiqlqxdmkc.supabase.co/functions/v1/sync-pages',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_bearer'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

do $$
begin
  perform cron.unschedule('fb-dashboard-process-comments');
exception when others then
  null;
end $$;

select cron.schedule(
  'fb-dashboard-process-comments', -- an toàn lưới, độc lập với sync-pages
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://wevdllaqnypiqlqxdmkc.supabase.co/functions/v1/process-comments',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_bearer'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
  $$
);

-- Nhân tiện hardening luôn 2 job của migration 0025 (wp-content/wp-publish) sang cùng cơ chế vault
-- — chúng đang hoạt động đúng nhờ đã set giá trị thật ngoài band, nhưng vẫn mang y hệt rủi ro "bị
-- ai/thứ gì áp lại file 0025 gốc (còn placeholder) đè mất" như vừa xảy ra với job này.
select cron.alter_job(
  6, -- fb-dashboard-wp-content (migration 0025)
  command => $$
  select net.http_post(
    url := 'https://wevdllaqnypiqlqxdmkc.supabase.co/functions/v1/wp-content',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_bearer'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
select cron.alter_job(
  7, -- fb-dashboard-wp-publish (migration 0025)
  command => $$
  select net.http_post(
    url := 'https://wevdllaqnypiqlqxdmkc.supabase.co/functions/v1/wp-publish',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_bearer'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Kiểm tra job:               select * from cron.job;
-- Xem lịch sử chạy:           select * from cron.job_run_details order by start_time desc limit 10;
-- Xem response HTTP:          select * from net._http_response order by created desc limit 10;
-- Xác nhận không còn secret/placeholder nào trong cron.job (chạy sau khi áp xong):
--   select jobid, jobname, command like '%<PROJECT_REF>%' as has_placeholder,
--          command like '%vault.decrypted_secrets%' as uses_vault
--   from cron.job;
