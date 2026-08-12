-- FB Post Dashboard — trạng thái phiên đăng nhập FB dùng để cào đối thủ (GLOBAL, không theo từng
-- page, khác hẳn competitor_page.last_error).
--
-- Bug thật (2026-08-12): worker cào "Overland Voices" chỉ ra 1 bài dù FB có rất nhiều bài mới —
-- xác nhận bằng headful browser: phiên đăng nhập (.fb-scraper/state.json) đã hết hạn, FB trả về
-- "màn login wall" (chỉ hiện 1 bài công khai) thay vì feed thật. BLOCKED_MARKERS hiện có (geo/
-- audience/bot-detect) không khớp kiểu chặn này nên collectFeed() không phát hiện được, âm thầm
-- ghi bài "thiếu" vào DB như thể đó là toàn bộ feed — mọi page đều dính chung vì cùng 1 phiên.
--
-- Bảng singleton (đúng 1 row, key='global' cố định) để FE đọc & hiện banner cảnh báo trên toàn
-- dashboard. RLS default-deny như các bảng khác (chỉ service_role đọc/ghi qua API routes/worker).
create table if not exists scraper_status (
  key                text primary key default 'global',
  session_expired    boolean not null default false,
  session_expired_at timestamptz,
  last_ok_at         timestamptz,
  updated_at         timestamptz not null default now()
);

insert into scraper_status (key) values ('global') on conflict (key) do nothing;

drop trigger if exists scraper_status_touch on scraper_status;
create trigger scraper_status_touch
  before update on scraper_status
  for each row execute function touch_updated_at();

alter table scraper_status enable row level security;
