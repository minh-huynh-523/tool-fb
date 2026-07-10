-- FB Post Dashboard — schema khởi tạo
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
-- Ghi chú: mọi truy cập đi qua API routes (service_role, bypass RLS).
-- Bật RLS default-deny bên dưới như lớp phòng thủ thêm (không ảnh hưởng service_role).

-- =========================================================
-- 1) facebook_page — page copy sẵn từ hercules `channels`
-- =========================================================
create table if not exists facebook_page (
  id                uuid primary key default gen_random_uuid(),
  page_id           text unique not null,        -- FB Page ID (= channels.app_id)
  name              text not null,
  picture           text,
  access_token      text not null,               -- page token (nên mã hoá bằng TOKEN_ENC_KEY)
  token_expires_at  timestamptz,                 -- optional
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- =========================================================
-- 2) post — bài post đồng bộ từ FB
-- =========================================================
create table if not exists post (
  id            uuid primary key default gen_random_uuid(),
  page_id       text not null references facebook_page(page_id) on delete cascade,
  fb_post_id    text unique not null,            -- "{pageId}_{postId}"
  message       text,
  permalink     text,
  media_type    text,                            -- photo | video | status | link | album ...
  media_url     text,                            -- ảnh/thumbnail để hiển thị
  fb_created_at timestamptz,
  raw           jsonb,
  synced_at     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists post_page_created_idx on post (page_id, fb_created_at desc);

-- =========================================================
-- 3) scheduled_comment — comment (delay 5s) + trạng thái
-- =========================================================
create table if not exists scheduled_comment (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references post(id) on delete cascade,
  fb_post_id     text not null,                  -- target để gọi Graph
  page_id        text not null,                  -- page nào comment (lấy token)
  message        text not null default '',
  attachment_url text,                           -- link đính kèm (first-comment)
  run_after      timestamptz not null,           -- now + COMMENT_DELAY_MS
  status         text not null default 'PENDING',-- PENDING | PROCESSING | SENT | FAILED
  attempts       int  not null default 0,
  claimed_at     timestamptz,                    -- set khi bắt đầu xử lý (idempotent claim / reclaim)
  fb_comment_id  text,                           -- id comment sau khi đăng
  error          text,
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists scheduled_comment_status_run_idx on scheduled_comment (status, run_after);
create index if not exists scheduled_comment_post_idx on scheduled_comment (post_id);

-- =========================================================
-- updated_at auto-touch cho facebook_page
-- =========================================================
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists facebook_page_touch on facebook_page;
create trigger facebook_page_touch
  before update on facebook_page
  for each row execute function touch_updated_at();

-- =========================================================
-- RLS: default-deny (service_role vẫn bypass). Không policy nào cho anon/authenticated
-- => client không truy cập trực tiếp được các bảng này.
-- =========================================================
alter table facebook_page     enable row level security;
alter table post              enable row level security;
alter table scheduled_comment enable row level security;
