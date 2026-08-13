-- FB Post Dashboard — chuyển 2 cron NẶNG NHẤT (Stage 2 sinh nội dung Gemini + Stage 3 đăng
-- WordPress/comment Facebook, xem lib/auto-publish.ts) RA KHỎI Vercel, chạy bằng Supabase Edge
-- Functions (supabase/functions/wp-content, supabase/functions/wp-publish) + pg_cron TRONG
-- Supabase — không tốn quota CPU/Memory của Vercel nữa (đây chính là nguyên nhân Vercel Hobby bị
-- PAUSE: sync-pages đã chạy mỗi PHÚT qua pg_cron từ migration 0005, cộng thêm 2 cron Gemini/WP/FB
-- mới thêm càng dồn tải).
--
-- ⚠️ CHẠY TRONG SUPABASE SQL EDITOR, SAU KHI ĐÃ DEPLOY 2 EDGE FUNCTION:
--   supabase functions deploy wp-content
--   supabase functions deploy wp-publish
-- rồi set secrets cho chúng (Project Settings → Edge Functions → Secrets, hoặc:
--   supabase secrets set GEMINI_API_KEY=... GEMINI_MODEL=... WP_XMLRPC_URL=... WP_BASE_URL=...
--     WP_CATEGORY=... WP_USER=... WP_PASSWORD=... TOKEN_ENC_KEY=... FACEBOOK_APP_SECRET=...
--     FACEBOOK_GRAPH_VERSION=...
-- ) — SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY Supabase TỰ bơm vào mọi Edge Function, không cần set.
--
-- Thay <PROJECT_REF> (vd abcdefgh) và <SERVICE_ROLE_KEY> bên dưới rồi chạy. Edge Function mặc định
-- yêu cầu JWT hợp lệ — dùng chính service_role key làm Bearer token cho pg_net gọi vào.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  perform cron.unschedule('fb-dashboard-wp-content');
exception when others then
  null;
end $$;
do $$
begin
  perform cron.unschedule('fb-dashboard-wp-publish');
exception when others then
  null;
end $$;

select cron.schedule(
  'fb-dashboard-wp-content',  -- Stage 2: sinh nội dung Gemini
  '*/5 * * * *',              -- mỗi 5 phút — không cần dày như sync-pages, Gemini/WP đắt hơn nhiều
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/wp-content',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

select cron.schedule(
  'fb-dashboard-wp-publish',  -- Stage 3: đăng WordPress + comment Facebook
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/wp-publish',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Kiểm tra job đã tạo:      select * from cron.job;
-- Xem lịch sử chạy:         select * from cron.job_run_details order by start_time desc limit 10;
-- Xem response HTTP:        select * from net._http_response order by created desc limit 10;
-- Tắt job:                  select cron.unschedule('fb-dashboard-wp-content');
--                            select cron.unschedule('fb-dashboard-wp-publish');
