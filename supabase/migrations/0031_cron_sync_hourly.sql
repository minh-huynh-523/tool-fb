-- FB Post Dashboard — BẬT LẠI cron sync ở nhịp thưa (1 giờ/lần).
--
-- BỐI CẢNH: migration 0029 unschedule hẳn 'fb-dashboard-sync' để cắt egress, và cảnh báo sẵn ở
-- ngay trong file đó rằng "comment hẹn cho reel chỉ gửi được SAU khi bấm đồng bộ". Cảnh báo ấy
-- thành sự thật ngày 2026-09-03: 13 comment hẹn 05:00–06:00 nằm im tới 10:50, chỉ đăng sau khi có
-- người bấm nút đồng bộ tay lúc 10:46 (đối chiếu post.synced_at với scheduled_comment.sent_at).
-- Trước đó 6 comment khác đã bị expireUnreachable() đánh FAILED vĩnh viễn vì quá 24h không ai bấm.
--
-- LÝ DO reel PHỤ THUỘC SYNC: reel lên lịch mang fb_post_id là video-id TRẦN cho tới khi lên sóng;
-- chỉ sync-pages mới reconcile nó thành <page>_<post>. processDueComments lọc `post!inner` +
-- like '*\_*' nên (đúng đắn) bỏ qua bài chưa reconcile — không sync thì hàng đợi đứng im, dù cron
-- process-comments vẫn chạy đều mỗi 5 phút và trả HTTP 200 với scanned:0.
--
-- CÂN ĐỐI CHI PHÍ: '0 * * * *' = 24 lượt/ngày, không đáng gì so với ~20.000 request/ngày của vòng
-- lặp claim→nhả đã diệt ở comments.ts — thủ phạm egress thật. Nhịp cũ '*/5' (288 lượt/ngày) mới là
-- thứ không cần thiết. Đổi lại: reel trễ tối đa 1 tiếng thay vì trễ vô hạn.
--
-- KÉO THEO (có chủ ý): sync-pages chạy nguyên chuỗi syncAllPages -> backupPostImages ->
-- enqueueWpContentCandidates -> processDueComments, nên backup ảnh và auto-publish cũng tự động
-- trở lại theo — đúng phần mà 0029 đã ghi là "muốn tự động lại thì bật đúng job này ở nhịp thưa".
--
-- Không chứa secret: host/bearer đọc từ vault lúc job CHẠY, y như 0025/0026/0029. Job upsert THEO
-- TÊN nên áp lại trên project trống cũng an toàn.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

select cron.schedule(
  'fb-dashboard-sync',  -- upsert theo jobname: 0029 đã unschedule, đây là tạo lại
  '0 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_base_url')
           || '/functions/v1/sync-pages',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_bearer'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Xác nhận sau khi áp (kỳ vọng: 4 job, fb-dashboard-sync active ở '0 * * * *', uses_vault = true):
--   select jobid, jobname, schedule, active,
--          command like '%vault.decrypted_secrets%' as uses_vault
--   from cron.job order by jobname;
