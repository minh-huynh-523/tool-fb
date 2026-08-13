-- FB Post Dashboard — auto-publish: bài đủ ngưỡng (comment thật + reaction > N) tự sinh bài WP
-- (Gemini) + tự đăng + tự comment link "Full story" vào bài FB gốc, KHÔNG cần bấm tay.
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
--
-- 2 hàng đợi TÁCH RỜI thay vì xử lý gộp 1 lượt:
--   wp_content_queue  — sinh nội dung qua Gemini (hay chậm/rate-limit)
--   wp_publish_queue  — đăng WordPress + comment FB (khác hẳn kiểu lỗi/độ trễ)
-- Tách để 1 lượt Gemini tốn tiền không phải làm lại chỉ vì bước đăng WP/comment hỏng, và ngược
-- lại. Cùng pattern claim/PROCESSING/stale-reclaim với scheduled_comment (xem lib/comments.ts).

create table if not exists wp_content_queue (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid unique not null references post(id) on delete cascade, -- 1 hàng/post, chặn enqueue trùng
  status       text not null default 'PENDING', -- PENDING | PROCESSING | DONE | FAILED
  attempts     int not null default 0,
  error        text,
  claimed_at   timestamptz,
  title        text,          -- kết quả Gemini (lib/wp-article-gen.ts) — giữ lại để audit/debug
  content_html text,
  image_url    text,
  source_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists wp_content_queue_status_idx on wp_content_queue (status, created_at);

create table if not exists wp_publish_queue (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid unique not null references post(id) on delete cascade,
  status       text not null default 'PENDING', -- PENDING | PROCESSING | PUBLISHED | FAILED
  attempts     int not null default 0,
  error        text,
  claimed_at   timestamptz,
  title        text not null,           -- copy từ wp_content_queue lúc enqueue — không join lại
  content_html text not null,
  image_url    text,
  source_url   text,
  wp_post_id   text,
  permalink    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists wp_publish_queue_status_idx on wp_publish_queue (status, created_at);

drop trigger if exists wp_content_queue_touch on wp_content_queue;
create trigger wp_content_queue_touch
  before update on wp_content_queue
  for each row execute function touch_updated_at();

drop trigger if exists wp_publish_queue_touch on wp_publish_queue;
create trigger wp_publish_queue_touch
  before update on wp_publish_queue
  for each row execute function touch_updated_at();

-- RLS default-deny như các bảng khác (chỉ service_role đọc/ghi qua API routes/cron).
alter table wp_content_queue enable row level security;
alter table wp_publish_queue enable row level security;
