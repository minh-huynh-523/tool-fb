-- FB Post Dashboard — theo dõi page ĐỐI THỦ (cào bằng Playwright, KHÔNG có token Graph)
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
-- Worker Playwright (chạy ở laptop, không phải Vercel) ghi 3 bảng này qua service_role.
-- Vercel chỉ ĐỌC để hiển thị. RLS default-deny như các bảng khác.

-- =========================================================
-- 1) competitor_page — danh sách page đối thủ cần theo dõi
-- =========================================================
create table if not exists competitor_page (
  id                  uuid primary key default gen_random_uuid(),
  handle              text unique not null,          -- vanity (readfullstory2023) hoặc ID số
  fb_page_id          text,                          -- ID số thật (điền sau khi cào lần đầu)
  name                text,                          -- tên page (cào về)
  picture             text,
  kind                text not null default 'page',  -- page | profile
  active              bool not null default true,    -- false = tạm bỏ qua (vd geo-block)
  last_scraped_at     timestamptz,
  scrape_requested_at timestamptz,                   -- nút "Cào ngay" trên Vercel set = now() → worker poll thấy thì cào
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- =========================================================
-- 2) competitor_post — bài của page đối thủ (cào về)
-- =========================================================
create table if not exists competitor_post (
  id                 uuid primary key default gen_random_uuid(),
  competitor_page_id uuid not null references competitor_page(id) on delete cascade,
  fb_post_id         text not null,                  -- parse từ permalink / GraphQL
  permalink          text,
  caption            text,                           -- message.text từ GraphQL
  media_type         text,                           -- photo | video | reel | link | status
  media_url          text,
  fb_created_at      timestamptz,                    -- creation_time
  raw                jsonb,
  scraped_at         timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (competitor_page_id, fb_post_id)
);
create index if not exists competitor_post_page_created_idx
  on competitor_post (competitor_page_id, fb_created_at desc);

-- =========================================================
-- 3) competitor_comment — CHỈ comment của chính page đối thủ (first-comment / phần tiếp)
-- =========================================================
create table if not exists competitor_comment (
  id                 uuid primary key default gen_random_uuid(),
  competitor_post_id uuid not null references competitor_post(id) on delete cascade,
  fb_comment_id      text,
  author_name        text,                           -- == tên page (đã lọc author == page)
  message            text,                           -- body.text
  link_url           text,                           -- URL tách từ message/attachment ("Full story: …")
  commented_at       timestamptz,
  scraped_at         timestamptz not null default now(),
  unique (competitor_post_id, fb_comment_id)
);
create index if not exists competitor_comment_post_idx
  on competitor_comment (competitor_post_id);

-- =========================================================
-- updated_at auto-touch (tái dùng function touch_updated_at() từ 0001_init.sql)
-- =========================================================
drop trigger if exists competitor_page_touch on competitor_page;
create trigger competitor_page_touch
  before update on competitor_page
  for each row execute function touch_updated_at();

-- =========================================================
-- Seed 12 handle từ danh sách user.
-- 3 page xem được từ IP VN → active=true (đã biết tên qua spike).
-- 9 page geo-block IP VN → active=false (bật lại khi có VPN).
-- =========================================================
insert into competitor_page (handle, fb_page_id, name, kind, active) values
  ('61586879402323',  '61586879402323', 'Vault of Stories', 'page',    true),
  ('61581662806484',  '61581662806484', 'The Story Beyond', 'page',    true),
  ('61582103185253',  '61582103185253', 'Overland Voices',  'page',    true),
  ('61558031870342',  '61558031870342', null,               'page',    false),
  ('61557419144931',  '61557419144931', null,               'page',    false),
  ('886026031437244', '886026031437244',null,               'page',    false),
  ('100076204362112', '100076204362112',null,               'profile', false),
  ('100064567096695', '100064567096695',null,               'profile', false),
  ('readfullstory2023',   null, null, 'page', false),
  ('justgoodstories2023', null, null, 'page', false),
  ('readthisstory',       null, null, 'page', false),
  ('good.stories1',       null, null, 'page', false)
on conflict (handle) do nothing;

-- =========================================================
-- RLS: default-deny (service_role bypass). Client không truy cập trực tiếp.
-- =========================================================
alter table competitor_page    enable row level security;
alter table competitor_post    enable row level security;
alter table competitor_comment enable row level security;
