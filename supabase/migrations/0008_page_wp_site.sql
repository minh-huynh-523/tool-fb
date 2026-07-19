-- Mỗi page đăng lên 1 site WordPress riêng (user/password vẫn dùng chung ở env).
-- Chạy TRƯỚC khi deploy code mới. Cột NULL = fallback về env WP_XMLRPC_URL/WP_BASE_URL/WP_CATEGORY
-- nên page cũ giữ nguyên hành vi, không cần backfill.
alter table facebook_page
  add column if not exists wp_xmlrpc_url text,  -- vd https://site.vn/xmlrpc.php
  add column if not exists wp_base_url   text,  -- vd https://site.vn (không có dấu / cuối)
  add column if not exists wp_category   text;  -- tên category, mặc định "Story"
