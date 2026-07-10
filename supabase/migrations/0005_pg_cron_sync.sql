-- FB Post Dashboard — cron TRONG Supabase (pg_cron + pg_net) thay cho cron-job.org
-- Mỗi phút: Supabase tự gọi endpoint sync của app -> kéo bài mới + reconcile reel
-- lên lịch vừa publish + gửi comment tới hạn.
--
-- ⚠️ CHẠY TRONG SUPABASE SQL EDITOR: thay <CRON_SECRET> bên dưới bằng giá trị CRON_SECRET
-- bạn đã đặt trên Vercel (Project Settings → Environment Variables) rồi chạy.
-- (Local dev không dùng được — pg_net không gọi được localhost.)

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Xoá job cũ nếu chạy lại migration (idempotent).
do $$
begin
  perform cron.unschedule('fb-dashboard-sync');
exception when others then
  null; -- job chưa tồn tại -> bỏ qua
end $$;

select cron.schedule(
  'fb-dashboard-sync',   -- tên job (xem/quản lý trong bảng cron.job)
  '* * * * *',           -- mỗi phút
  $$
  select net.http_get(
    url := 'https://tool-fb-klta.vercel.app/api/cron/sync-pages?secret=<CRON_SECRET>',
    timeout_milliseconds := 55000
  );
  $$
);

-- Kiểm tra job đã tạo:      select * from cron.job;
-- Xem lịch sử chạy:         select * from cron.job_run_details order by start_time desc limit 10;
-- Xem response HTTP:        select * from net._http_response order by created desc limit 10;
-- Tắt job:                  select cron.unschedule('fb-dashboard-sync');
