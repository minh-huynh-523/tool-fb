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

### Cron safety-net (đăng nốt comment sót)
Tạo job ở [cron-job.org](https://cron-job.org) (free) gọi mỗi 1–5 phút:

```
GET https://<app>.vercel.app/api/cron/process-comments?secret=<CRON_SECRET>
```

(hoặc header `x-cron-secret: <CRON_SECRET>`). Endpoint quét các comment `PENDING` quá hạn / `PROCESSING` treo và đăng nốt.

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
    pages/ (+[pageId]/sync, [pageId]/test-token, sync-all)
    posts/[postDbId]/comments   inline delay 5s
    cron/process-comments        safety-net (CRON_SECRET)
lib/
  supabase/{server,client,admin}.ts
  facebook/{config,client}.ts
  crypto.ts comments.ts sync.ts queries.ts date.ts types.ts
middleware.ts               refresh session + guard route
supabase/migrations/0001_init.sql
```
