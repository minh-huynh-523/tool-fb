-- FB Post Dashboard — bài viết cào về + đăng nháp WordPress (1-1 với post)
-- Chạy: supabase db push (hoặc dán vào Supabase SQL editor)

create table if not exists scraped_article (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid unique not null references post(id) on delete cascade, -- 1-1 với FB post
  source_url  text not null,                    -- link bài gốc (1millionstories…)
  title       text,
  wp_post_id  text,                             -- id bài trên WordPress
  wp_status   text,                             -- draft | publish
  wp_edit_url text,                             -- link mở nháp trong wp-admin
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS default-deny (service_role vẫn bypass) — client không truy cập trực tiếp.
alter table scraped_article enable row level security;
