-- FB Post Dashboard — view gộp 2 bảng hàng đợi auto-publish, để trang /link-comments phân trang
-- được Ở TẦNG DB.
--
-- Trước migration này, listAutoPublishQueue() (lib/queries.ts) kéo TOÀN BỘ wp_content_queue +
-- wp_publish_queue về rồi mới merge và .slice() trong JS — vì PostgREST không UNION được. Ghi chú
-- trong code nói "2 bảng còn nhỏ", nhưng chúng chỉ có tăng: mỗi bài auto-publish thêm 1 row và
-- không có gì dọn. Cùng loại lỗi với vòng lặp comment đã làm egress tăng vọt (xem 0029), chỉ khác
-- là nó tính theo lượt XEM TRANG thay vì lượt cron.
--
-- Quy tắc gộp phải khớp ĐÚNG precedence mà JS đang dùng: có hàng ở wp_publish_queue thì hàng
-- wp_content_queue chỉ còn là lịch sử (đã DONE) — trạng thái "đang treo" cần hiện luôn là hàng ở
-- giai đoạn SAU. Nên khi có publish row thì lấy TẤT CẢ trường từ nó.
--
-- ⚠ Dùng CASE chứ KHÔNG dùng coalesce(p.x, c.x): `error` và `permalink` của publish row hợp lệ khi
-- NULL (đăng thành công thì không có lỗi), coalesce sẽ lôi nhầm error cũ của content row lên.
--
-- LEFT JOIN từ wp_content_queue là đủ phủ hết: chỗ DUY NHẤT ghi vào wp_publish_queue là
-- supabase/functions/wp-content/index.ts, và nó chỉ bắc cầu từ một hàng wp_content_queue đang xử
-- lý ⇒ post_id của publish luôn là tập con của content. (Đã kiểm trên dữ liệu thật: 60/60, không
-- có hàng publish nào mồ côi.)

create or replace view auto_publish_queue
with (security_invoker = true) as
select
  c.post_id,
  case when p.post_id is null then 'content' else 'publish' end as stage,
  case when p.post_id is null then c.status     else p.status     end as status,
  case when p.post_id is null then c.attempts   else p.attempts   end as attempts,
  case when p.post_id is null then c.error      else p.error      end as error,
  case when p.post_id is null then null         else p.permalink  end as permalink,
  case when p.post_id is null then c.created_at else p.created_at end as created_at
from wp_content_queue c
left join wp_publish_queue p on p.post_id = c.post_id;

-- PostgREST đọc view qua các role này. security_invoker = true ở trên nghĩa là RLS của 2 bảng gốc
-- vẫn được áp theo người GỌI, không phải theo owner của view — view không trở thành cửa sau.
grant select on auto_publish_queue to service_role;
grant select on auto_publish_queue to authenticated;

-- Kiểm tra: select stage, status, count(*) from auto_publish_queue group by 1,2 order by 1,2;
--           select count(*) from auto_publish_queue;  -- phải bằng count(*) từ wp_content_queue
