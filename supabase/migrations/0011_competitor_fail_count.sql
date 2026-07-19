-- FB Post Dashboard — tự tắt page cào hỏng để khỏi phí thời gian mỗi lượt.
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
--
-- Trước đây page hỏng chỉ ghi last_error nhưng vẫn active=true → mỗi 6h lại thử lại,
-- mỗi lần tốn timeout 45s + delay 8s. 9 page geo-block ở 0007 phải tắt bằng tay.
-- Giờ worker tự xử (xem markError() trong lib/fb-scraper/worker.ts):
--   • Lỗi bị chặn (geo/audience/bot-detect) → active=false NGAY, không thử lại.
--   • Lỗi tạm thời (timeout, mạng chập)    → đếm; đủ 3 lượt liên tiếp mới tắt.
--   • Cào lại được                          → fail_count về 0.
-- Bật lại bằng nút "Bật" trên UI (vd sau khi mở VPN).

alter table competitor_page
  add column if not exists fail_count int not null default 0;
