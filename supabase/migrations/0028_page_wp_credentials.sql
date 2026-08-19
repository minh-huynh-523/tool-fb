-- FB Post Dashboard — credential WordPress RIÊNG cho từng page.
--
-- Migration 0008 mới tách được URL theo page, còn user/password vẫn dùng chung ở env
-- (WP_USER/WP_PASSWORD) — nên 2 site WordPress khác mật khẩu thì KHÔNG cùng chạy được: page trỏ
-- site mới vẫn gửi mật khẩu của site cũ và fail auth. 2 cột dưới đây gỡ ràng buộc đó.
--
-- wp_password_enc lưu dạng AES-256-GCM `v1:<iv>:<tag>:<ciphertext>` (lib/crypto.ts encryptToken),
-- CÙNG định dạng + CÙNG khoá TOKEN_ENC_KEY với facebook_page.access_token. Không bao giờ ghi
-- plaintext qua API — chỉ decryptToken() lúc gọi XML-RPC. Nếu ai đó paste tay plaintext vào
-- Supabase thì decryptToken() vẫn trả nguyên (chuỗi không có tiền tố `v1:`), giống access_token.
--
-- NULL cả 2 cột = page dùng credential chung ở env, hành vi cũ giữ nguyên, không cần backfill.
-- Hai cột đi THEO CẶP: code từ chối chạy khi chỉ set 1 trong 2, để không lặp lại đúng lỗi
-- "user site mới + password site cũ".
alter table facebook_page
  add column if not exists wp_user         text,  -- vd btv
  add column if not exists wp_password_enc text;  -- v1:<iv_hex>:<tag_hex>:<ciphertext_hex>

comment on column facebook_page.wp_user is
  'Username WordPress riêng của page (null = dùng env WP_USER). Đi cặp với wp_password_enc.';
comment on column facebook_page.wp_password_enc is
  'Password WordPress đã mã hoá AES-256-GCM bằng TOKEN_ENC_KEY (null = dùng env WP_PASSWORD).';
