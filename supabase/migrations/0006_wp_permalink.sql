-- Chạy TRƯỚC khi deploy code mới (code select/upsert cột này).
alter table scraped_article add column if not exists wp_permalink text; -- link công khai (?p=ID khi còn draft)
