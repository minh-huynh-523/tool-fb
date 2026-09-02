# FB Post Dashboard

Dashboard cá nhân quản lý bài post Facebook + **auto-comment (delay ~5s)**.
Next.js (App Router) · Supabase (Postgres + Auth) · Facebook Graph API. Host free trên **Vercel + Supabase**.

Luồng: bạn tự đăng bài trên FB → **Đồng bộ** post về → **thêm comment** (nhập tay) → hệ thống đăng comment sau ~5s.
**Không** đăng bài / **không** OAuth: page token được **copy sẵn** từ hercules `channels` vào Supabase.

---

## 1. Chuẩn bị

### Supabase
1. Tạo project free tại [supabase.com](https://supabase.com).
2. **SQL Editor** → chạy nội dung `supabase/migrations/0001_init.sql` (tạo 3 bảng + RLS).
3. **Authentication → Users** → **Add user** (email + mật khẩu của bạn). Vào **Providers → Email** → *tắt* "Allow new users to sign up" (chỉ mình bạn đăng nhập).
4. **Project Settings → API** → lấy: `Project URL`, `anon public` key, `service_role` key.

### Facebook page token
Copy từ hercules bảng `channels`: `app_id` → `page_id`, `access_token`, `name`. (Token phải có quyền
`pages_read_engagement` + `pages_manage_engagement`.)

---

## 2. Cấu hình env

Copy `.env.example` → `.env.local` và điền:

```
NEXT_PUBLIC_SUPABASE_URL=...        # Project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=...   # anon public key
SUPABASE_SERVICE_ROLE_KEY=...       # service_role (server-only)
FACEBOOK_GRAPH_VERSION=v25.0
FACEBOOK_APP_SECRET=                # optional (chỉ khi app bật appsecret_proof)
COMMENT_DELAY_MS=5000
TOKEN_ENC_KEY=                      # optional: 64 hex (32 bytes) mã hoá token; sinh: openssl rand -hex 32
CRON_SECRET=...                     # bảo vệ endpoint cron
```

> ⚠️ `NEXT_PUBLIC_*` được **inline lúc build** — trên Vercel phải khai chúng trong Environment Variables
> **trước khi build**. Đổi giá trị này thì phải build lại.

---

## 3. Chạy local

```bash
npm install
npm run dev        # http://localhost:3000
```

- `/login` → đăng nhập bằng user đã tạo trong Supabase Auth.
- `/pages` → **Thêm page** (dán page_id + access_token) → **Test token** → **Đồng bộ**.
- `/posts` → **Đồng bộ tất cả page**, lọc *Hôm nay* / *Chưa có comment* → mở post → **Thêm comment**.

---

## 4. Deploy (Vercel, free)

1. Push repo lên GitHub → import vào Vercel.
2. Khai **tất cả** biến env ở **Project Settings → Environment Variables**.
3. Deploy. Test lại luồng trên domain `*.vercel.app`.

### Cron production

Vercel chỉ còn là UI — mọi việc chạy nền nằm ở **Supabase Edge Function**, hẹn giờ bằng **pg_cron +
pg_net ngay trong Supabase** (migration 0025/0026/0029). Không có route `/api/cron/*` nào nữa.

| job | nhịp | gọi Edge Function | làm gì |
|---|---|---|---|
| `fb-dashboard-process-comments` | `*/5` | `process-comments` | lưới an toàn: gửi `scheduled_comment` tới hạn |
| `fb-dashboard-wp-content` | `*/10` | `wp-content` | Stage 2 auto-publish: Gemini sinh bài WP |
| `fb-dashboard-wp-publish` | `*/10` | `wp-publish` | Stage 3: đăng WordPress + comment FB |

**`fb-dashboard-sync` đã bị TẮT có chủ ý** (migration 0029) — sync chạy **bấm tay** bằng nút
*"Đồng bộ tất cả page"* ở `/posts` và `/wp-needed`. Lý do: chuỗi cron → Edge Function → PostgREST
là nguồn egress lớn nhất của project (đo được 31.390 request/24h, gần như 100% từ Edge Function
chứ không phải người dùng), trong khi sync mỗi 5 phút không mang lại gì tương xứng.

> ⚠ `sync-pages` chạy trọn chuỗi `sync → backup ảnh → enqueue auto-publish → gửi comment tới hạn`,
> nên **backup ảnh và enqueue auto-publish cũng thành thủ công theo**. Muốn auto-publish chạy hết
> một vòng ngay thì bấm *"Chạy auto-publish ngay"* ở `/prompts`. Việc reconcile reel lên lịch cũng
> chỉ xảy ra lúc bấm sync ⇒ comment hẹn cho reel chờ tới lúc đó (quá 24h thì tự chuyển `FAILED`
> kèm lý do, không kẹt `PENDING` im lặng).
>
> Muốn quay lại sync tự động: `cron.schedule('fb-dashboard-sync', '0 * * * *', ...)` theo đúng khuôn
> trong `0029_cron_manual_sync.sql`. Đừng đặt cron riêng cho `auto-publish-enqueue` — nó chỉ xét bài
> đã có trong DB, không sync thì không có gì để xét.

Kiểm tra: `select jobname, schedule, active from cron.job order by jobname;` và
`select * from cron.job_run_details order by start_time desc limit 5;`

### Chuyển sang một project Supabase khác

Toàn bộ việc chuyển nằm trong `scripts/switch-supabase-project.sh` (idempotent, chạy được từng bước):

```bash
export SUPABASE_ACCESS_TOKEN=...   # PAT của TÀI KHOẢN SỞ HỮU project mới
export NEW_SERVICE_ROLE_KEY=...    # Project Settings -> API Keys
export NEW_DB_PASSWORD=...         # Project Settings -> Database
export NEW_PROJECT_REF=<ref>       # mặc định: cajlcemkxycjssxqehyb

./scripts/switch-supabase-project.sh        # 1..6
./scripts/switch-supabase-project.sh 4 5    # chỉ deploy function + set secret
```

Sáu bước: link CLI → nạp vault secret → `db push` → deploy 5 Edge Function → `secrets set`
→ verify + sửa `.env.local`.

> `supabase migration up` KHÔNG thay được script này: không có cờ thì nó áp vào **database local
> (Docker)**, muốn chạm project thật phải `--linked`; và migration chỉ là 1 trong 6 bước — thiếu
> vault secret thì 4 cron job tạo ra URL `null` và fail mọi lượt, còn Edge Function thì không tự
> deploy.

Hai vault secret pg_cron cần (bước 2 tự nạp, hoặc dán tay vào SQL Editor **trước** khi push):

| secret | giá trị |
|---|---|
| `fb_dashboard_edge_bearer` | service_role key của project |
| `fb_dashboard_edge_base_url` | `https://<ref>.supabase.co` |

Migration 0025/0026 đọc cả hai lúc job **chạy**, nên không file nào trong repo chứa ref project hay
service_role key — áp lại lên project nào cũng đúng.

---

## Cơ chế comment 5s (tóm tắt)

`POST /api/posts/[id]/comments` → tạo row `scheduled_comment` (PENDING) → `sleep(5s)` →
**claim atomic** (`status PENDING → PROCESSING`, chống double-comment) → gọi Graph `POST /{postId}/comments`
→ cập nhật `SENT`/`FAILED`. Nếu function chết giữa chừng, cron safety-net đăng nốt (mô hình *at-least-once*).

## Cấu trúc

```
app/
  login/                    đăng nhập (Supabase Auth)
  (app)/                    khu vực đã đăng nhập (layout guard)
    pages/  posts/  posts/[id]/
    _components/            client components (form, actions, badge)
  api/
    pages/ (+[pageId]/sync, [pageId]/test-token, sync-all)  proxy mỏng -> Edge Function sync-pages
    posts/[postDbId]/comments   inline delay 5s
    auto-publish/run             proxy -> enqueue + wp-content + wp-publish (nút bấm tay)
lib/
  supabase/{server,client,admin}.ts
  facebook/{config,client}.ts
  crypto.ts comments.ts sync.ts queries.ts date.ts types.ts
middleware.ts               refresh session + guard route
supabase/migrations/0001_init.sql
```
