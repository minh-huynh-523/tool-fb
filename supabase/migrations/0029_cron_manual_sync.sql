-- FB Post Dashboard — cắt egress Supabase: TẮT cron sync, giãn nhịp 3 cron còn lại.
--
-- BỐI CẢNH (đo thật trên edge_logs, cửa sổ 24h): project ăn 31.390 request, trong đó 31.339 là
-- /rest/v1/* và gần như 100% mang User-Agent `Deno/... SupabaseEdgeRuntime` — tức chính các Edge
-- Function do pg_cron gọi, KHÔNG phải người dùng. Storage chỉ 44 request/ngày, DB vỏn vẹn ~20 MB.
-- Nói cách khác egress không đến từ dữ liệu to lên mà từ SỐ LẦN ĐỌC LẶP.
--
-- Thủ phạm chính đã sửa ở tầng code (supabase/functions/_shared/comments.ts): 6 row
-- scheduled_comment trỏ tới reel chưa lên sóng bị claim → nhả → claim lại vô hạn, ~20.000
-- request/ngày cho 6 row chết. File này lo phần còn lại: NHỊP GỌI.
--
-- ĐỔI HÀNH VI CÓ CHỦ Ý — sync chuyển sang BẤM TAY:
--   fb-dashboard-sync bị unschedule hẳn. Đường vào giờ là nút "Đồng bộ tất cả page" ở /posts và
--   /wp-needed -> app/api/pages/sync-all -> Edge Function sync-pages (vẫn chạy nguyên chuỗi
--   syncAllPages -> backupPostImages -> enqueueWpContentCandidates -> processDueComments).
--
--   ⚠ Hệ quả phải biết: backup ảnh VÀ enqueue auto-publish nằm CÙNG chuỗi đó, nên chúng cũng
--   thành thủ công theo. Không mất chức năng — nút "Chạy auto-publish ngay" ở /prompts
--   (app/api/auto-publish/run) gọi liền auto-publish-enqueue + wp-content + wp-publish. Việc
--   reconcile reel cũng thành thủ công ⇒ comment hẹn cho reel chỉ gửi được SAU khi bấm đồng bộ.
--   Muốn auto-publish tự động trở lại thì bật lại đúng job này ở nhịp thưa (vd '0 * * * *'), chứ
--   đừng đặt cron riêng cho auto-publish-enqueue — nó chỉ xét bài ĐÃ có trong DB, không sync thì
--   không có bài mới để xét.
--
-- fb-dashboard-process-comments GIỮ LẠI (chỉ giãn */2 -> */5): đây là thứ DUY NHẤT còn giữ cho
-- "comment lên lịch tự gửi đúng giờ" chạy tự động sau khi sync thành thủ công. Không được tắt.
--
-- Secret/host vẫn đọc từ Supabase Vault lúc job CHẠY, y như 0025/0026 — file này không chứa
-- secret nào, áp lại lên bất kỳ project nào cũng an toàn. Job định danh THEO TÊN (cron.schedule
-- upsert theo jobname) chứ không theo jobid, để `supabase db push` không vỡ trên project trống.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- =========================================================
-- 1) TẮT cron sync (migration 0005 tạo, 0026 repoint sang Edge Function)
-- =========================================================
-- Bọc exception: trên project trống / đã unschedule rồi thì cron.unschedule ném lỗi và sẽ kéo đổ
-- cả `supabase db push`.
do $$
begin
  perform cron.unschedule('fb-dashboard-sync');
exception when others then
  null;
end $$;

-- =========================================================
-- 2) Giãn nhịp 3 job còn lại
-- =========================================================
-- An toàn lưới cho hàng đợi scheduled_comment. */2 -> */5: sau fix ở comments.ts, mỗi lượt chỉ còn
-- 3 query rẻ khi hàng đợi rỗng, nhưng không có lý do gì chạy dày hơn 5 phút — Next.js đã gọi
-- thẳng process-comments với { commentId } ngay lúc insert (app/api/posts/[postDbId]/comments),
-- nên đây chỉ là lưới hứng, không phải đường chính.
select cron.schedule(
  'fb-dashboard-process-comments',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_base_url')
           || '/functions/v1/process-comments',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_bearer'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
  $$
);

-- Stage 2/3 auto-publish: GIỮ chạy nền để hoàn tất việc đã nằm trong queue (bấm "Chạy auto-publish
-- ngay" xong mà Gemini/WP lỗi giữa chừng thì 2 job này retry tiếp, không bắt người dùng bấm lại).
-- */5 -> */10: enqueue giờ chỉ xảy ra lúc bấm tay nên hàng đợi không còn tự đầy lên mỗi 5 phút.
select cron.schedule(
  'fb-dashboard-wp-content',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_base_url')
           || '/functions/v1/wp-content',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_bearer'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
select cron.schedule(
  'fb-dashboard-wp-publish',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_base_url')
           || '/functions/v1/wp-publish',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fb_dashboard_edge_bearer'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Xác nhận sau khi áp (kỳ vọng: KHÔNG còn dòng fb-dashboard-sync, 3 job còn lại đúng nhịp mới,
-- uses_vault = true ở cả 3):
--   select jobid, jobname, schedule, active,
--          command like '%vault.decrypted_secrets%' as uses_vault
--   from cron.job order by jobname;
