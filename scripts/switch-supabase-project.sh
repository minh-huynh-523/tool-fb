#!/usr/bin/env bash
#
# Chuyển fb-post-dashboard sang MỘT PROJECT SUPABASE KHÁC (schema mới, dữ liệu trống).
#
# Script này idempotent — chạy lại bao nhiêu lần cũng được, và chạy được TỪNG BƯỚC:
#   ./scripts/switch-supabase-project.sh            # chạy hết bước 1..6
#   ./scripts/switch-supabase-project.sh 3 4        # chỉ chạy bước 3 và 4
#
#   1. link Supabase CLI sang project mới
#   2. nạp 2 vault secret pg_cron cần (bearer + base url)   <-- PHẢI trước bước 3
#   3. supabase db push  (28 migration -> schema + bucket post-media + 4 cron job)
#   4. deploy 5 Edge Function
#   5. supabase secrets set  (đọc giá trị app từ .env.local hiện tại)
#   6. verify + in checklist việc còn phải làm tay
#
# ===== BIẾN BẮT BUỘC (export trước khi chạy) =====
#   SUPABASE_ACCESS_TOKEN   Personal access token của TÀI KHOẢN SỞ HỮU project mới.
#                           Token trong .env.local hiện tại KHÔNG dùng được — nó thuộc account
#                           khác (chỉ thấy project cũ wevdllaqnypiqlqxdmkc, gọi project mới trả
#                           403). Tạo mới ở https://supabase.com/dashboard/account/tokens
#   NEW_SERVICE_ROLE_KEY    service_role / sb_secret_... của project mới
#                           (Dashboard -> Project Settings -> API Keys)
#   NEW_DB_PASSWORD         mật khẩu database của project mới
#                           (Project Settings -> Database -> Reset database password nếu quên)
#
# SUPABASE_ACCESS_TOKEN và NEW_SERVICE_ROLE_KEY được tự lấy từ .env.local nếu file đó đã trỏ sang
# project mới (SUPABASE_URL khớp) — lúc đó chỉ cần export NEW_DB_PASSWORD.
#
# ===== BIẾN TUỲ CHỌN =====
#   NEW_PROJECT_REF         mặc định cajlcemkxycjssxqehyb
#   WRITE_ENV_LOCAL=0       bỏ qua việc tự cập nhật .env.local ở bước 6
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

NEW_PROJECT_REF="${NEW_PROJECT_REF:-cajlcemkxycjssxqehyb}"
NEW_SUPABASE_URL="https://${NEW_PROJECT_REF}.supabase.co"
API="https://api.supabase.com/v1"
ENV_FILE=".env.local"
WRITE_ENV_LOCAL="${WRITE_ENV_LOCAL:-1}"

FUNCTIONS=(sync-pages process-comments wp-content wp-publish auto-publish-enqueue)

# Secret cho Edge Function — đúng bộ Deno.env.get() mà supabase/functions/* đọc.
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY KHÔNG có ở đây: Supabase tự bơm vào mọi Edge Function
# (và `supabase secrets set` cũng cấm tên bắt đầu bằng SUPABASE_).
EDGE_SECRETS=(
  FACEBOOK_GRAPH_VERSION FACEBOOK_APP_SECRET TOKEN_ENC_KEY
  GEMINI_API_KEY GEMINI_MODEL GEMINI_TIMEOUT_MS
  WP_USER WP_PASSWORD WP_XMLRPC_URL WP_BASE_URL WP_CATEGORY
  AUTO_PUBLISH_MIN_REACTIONS AUTO_PUBLISH_MIN_COMMENTS AUTO_PUBLISH_CUTOFF_HOUR
)

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mLỖI: %s\033[0m\n' "$*" >&2; exit 1; }

# Đọc 1 biến từ .env.local theo đúng luật dotenv (bỏ comment cuối dòng, gỡ nháy) — KHÔNG source
# file để tránh shell diễn giải giá trị.
env_get() {
  ENV_FILE="$ENV_FILE" KEY="$1" python3 - <<'PY'
import os, re, sys
key, path = os.environ["KEY"], os.environ["ENV_FILE"]
val = ""
try:
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() != key:
            continue
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            val = v[1:-1]
        else:
            val = re.sub(r"\s+#.*$", "", v).strip()
except FileNotFoundError:
    pass
sys.stdout.write(val)
PY
}

# Chạy SQL trên project mới qua Management API (không cần psql/pooler).
sql() {
  local out
  out=$(QUERY="$1" python3 -c 'import json,os;print(json.dumps({"query":os.environ["QUERY"]}))' \
    | curl -sS -X POST "$API/projects/$NEW_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" --data-binary @-)
  case "$out" in
    '{"message":'*) die "SQL thất bại: $out" ;;
  esac
  printf '%s' "$out"
}

# Escape 1 giá trị thành string literal SQL.
sql_lit() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

# Danh sách bước cần chạy, lưu dạng CHUỖI (bash 3.2 của macOS lỗi "unbound variable" khi expand
# mảng rỗng dưới `set -u`). Rỗng = chạy hết.
STEPS=" $* "

want_step() {
  [ -z "${STEPS// /}" ] && return 0
  case "$STEPS" in *" $1 "*) return 0 ;; esac
  return 1
}

# ---------------------------------------------------------------- bước 0: preflight
say "Bước 0 — kiểm tra điều kiện"
command -v python3 >/dev/null || die "cần python3"
command -v npx     >/dev/null || die "cần npx (Node)"
[ -f "$ENV_FILE" ] || die "không thấy $ENV_FILE ở $(pwd)"
# Hai giá trị đầu có thể lấy thẳng từ .env.local nếu file đó ĐÃ trỏ sang project mới — khi đó chỉ
# còn NEW_DB_PASSWORD là bắt buộc export (mật khẩu DB không nằm trong .env.local).
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  SUPABASE_ACCESS_TOKEN="$(env_get SUPABASE_ACCESS_TOKEN)"
  [ -n "$SUPABASE_ACCESS_TOKEN" ] && ok "SUPABASE_ACCESS_TOKEN lấy từ $ENV_FILE"
fi
if [ -z "${NEW_SERVICE_ROLE_KEY:-}" ]; then
  env_url="$(env_get SUPABASE_URL)"
  [ "$env_url" = "$NEW_SUPABASE_URL" ] || die "chưa export NEW_SERVICE_ROLE_KEY, mà cũng không lấy được từ $ENV_FILE:
       SUPABASE_URL ở đó đang là '${env_url:-<trống>}', không phải $NEW_SUPABASE_URL.
       Lấy nhầm key của project cũ thì cron gọi Edge Function sẽ 401 — nên script dừng ở đây."
  NEW_SERVICE_ROLE_KEY="$(env_get SUPABASE_SERVICE_ROLE_KEY)"
  [ -n "$NEW_SERVICE_ROLE_KEY" ] && ok "NEW_SERVICE_ROLE_KEY lấy từ $ENV_FILE"
fi
: "${SUPABASE_ACCESS_TOKEN:?chưa export SUPABASE_ACCESS_TOKEN (PAT của tài khoản sở hữu project mới)}"
: "${NEW_SERVICE_ROLE_KEY:?chưa export NEW_SERVICE_ROLE_KEY}"
: "${NEW_DB_PASSWORD:?chưa export NEW_DB_PASSWORD (Project Settings -> Database -> Reset database password nếu quên)}"
export SUPABASE_ACCESS_TOKEN   # Supabase CLI đọc thẳng biến này, không cần `supabase login`

http_code=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "$API/projects/$NEW_PROJECT_REF/api-keys")
[ "$http_code" = "200" ] || die "SUPABASE_ACCESS_TOKEN không truy cập được project $NEW_PROJECT_REF (HTTP $http_code).
       Token phải thuộc tài khoản SỞ HỮU project đó — token trong .env.local hiện tại là của account khác."
ok "token hợp lệ cho project $NEW_PROJECT_REF ($NEW_SUPABASE_URL)"

old_ref=$(cat supabase/.temp/project-ref 2>/dev/null || echo "-")
[ "$old_ref" = "$NEW_PROJECT_REF" ] || warn "CLI đang link tới: $old_ref (bước 1 sẽ đổi)"

# ---------------------------------------------------------------- bước 1: link
if want_step 1; then
  say "Bước 1 — link Supabase CLI sang $NEW_PROJECT_REF"
  npx --yes supabase link --project-ref "$NEW_PROJECT_REF" --password "$NEW_DB_PASSWORD"
  ok "đã link"
fi

# ---------------------------------------------------------------- bước 2: vault
if want_step 2; then
  say "Bước 2 — nạp vault secret cho pg_cron (chạy TRƯỚC db push)"
  # Migration 0025/0026 KHÔNG chứa ref project lẫn service_role key: cả hai đọc từ vault lúc job
  # chạy. Thiếu 2 secret này thì cron vẫn được tạo nhưng URL ra null và mọi lượt gọi đều fail.
  sql "create extension if not exists supabase_vault;" >/dev/null
  for pair in "fb_dashboard_edge_bearer=$NEW_SERVICE_ROLE_KEY" "fb_dashboard_edge_base_url=$NEW_SUPABASE_URL"; do
    name="${pair%%=*}"; value="${pair#*=}"
    sql "do \$do\$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = $(sql_lit "$name");
  if v_id is null then
    perform vault.create_secret($(sql_lit "$value"), $(sql_lit "$name"), 'fb-post-dashboard: pg_cron goi Edge Function');
  else
    perform vault.update_secret(v_id, $(sql_lit "$value"));
  end if;
end \$do\$;" >/dev/null
    ok "vault secret $name"
  done
fi

# ---------------------------------------------------------------- bước 3: migrations
if want_step 3; then
  say "Bước 3 — supabase db push (schema + bucket post-media + cron job)"
  npx --yes supabase db push --password "$NEW_DB_PASSWORD"
  ok "đã áp migration"
fi

# ---------------------------------------------------------------- bước 4: edge functions
if want_step 4; then
  say "Bước 4 — deploy Edge Function"
  for fn in "${FUNCTIONS[@]}"; do
    npx --yes supabase functions deploy "$fn" --project-ref "$NEW_PROJECT_REF"
    ok "$fn"
  done
fi

# ---------------------------------------------------------------- bước 5: edge secrets
if want_step 5; then
  say "Bước 5 — set secret cho Edge Function (lấy từ $ENV_FILE)"
  args=()
  missing=()
  for k in "${EDGE_SECRETS[@]}"; do
    v="$(env_get "$k")"
    if [ -n "$v" ]; then args+=("$k=$v"); else missing+=("$k"); fi
  done
  [ "${#args[@]}" -gt 0 ] || die "không đọc được biến nào từ $ENV_FILE"
  npx --yes supabase secrets set --project-ref "$NEW_PROJECT_REF" "${args[@]}" >/dev/null
  ok "đã set ${#args[@]} secret: $(printf '%s ' "${args[@]%%=*}")"
  # Không sao nếu thiếu: project CŨ cũng chỉ set đúng 10 secret (GEMINI_TIMEOUT_MS và 3 biến
  # AUTO_PUBLISH_* chưa từng được set) — Edge Function tự dùng giá trị mặc định trong code.
  [ "${#missing[@]}" -eq 0 ] || warn "trống trong $ENV_FILE nên bỏ qua (Edge Function dùng default): ${missing[*]}"
fi

# ---------------------------------------------------------------- bước 6: verify
if want_step 6; then
  say "Bước 6 — verify"

  printf '  cron job:\n'
  sql "select jobname, schedule, active,
              command like '%vault.decrypted_secrets%' as uses_vault,
              command like '%.supabase.co%'            as hardcoded_host
       from cron.job order by jobid;" \
    | python3 -c 'import sys,json;[print("    %-32s %-12s active=%-5s vault=%-5s hardcoded_host=%s" % (r["jobname"],r["schedule"],r["active"],r["uses_vault"],r["hardcoded_host"])) for r in json.load(sys.stdin)] or print("    (chưa có job nào!)")'

  printf '  bảng + bucket:\n'
  sql "select (select count(*) from information_schema.tables where table_schema='public') as tables,
              (select count(*) from storage.buckets where id='post-media')                 as post_media_bucket,
              (select count(*) from prompt_template)                                       as prompt_template_rows,
              (select count(*) from vault.secrets where name like 'fb_dashboard_%')        as vault_secrets;" \
    | python3 -c 'import sys,json;r=json.load(sys.stdin)[0];print("    tables=%s  bucket post-media=%s  prompt_template=%s  vault_secrets=%s" % (r["tables"],r["post_media_bucket"],r["prompt_template_rows"],r["vault_secrets"]))'

  printf '  edge function:\n'
  curl -sS -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "$API/projects/$NEW_PROJECT_REF/functions" \
    | python3 -c 'import sys,json;[print("    %-24s %s" % (f["slug"],f["status"])) for f in json.load(sys.stdin)]'

  if [ "$WRITE_ENV_LOCAL" = "1" ]; then
    say "Cập nhật $ENV_FILE (giữ bản cũ ở $ENV_FILE.bak)"
    cp "$ENV_FILE" "$ENV_FILE.bak"
    ENV_FILE="$ENV_FILE" URL="$NEW_SUPABASE_URL" KEY="$NEW_SERVICE_ROLE_KEY" TOKEN="$SUPABASE_ACCESS_TOKEN" python3 - <<'PY'
import os, re
path = os.environ["ENV_FILE"]
repl = {
    "SUPABASE_URL": os.environ["URL"],
    "SUPABASE_SERVICE_ROLE_KEY": os.environ["KEY"],
    "SUPABASE_ACCESS_TOKEN": os.environ["TOKEN"],
}
out, seen = [], set()
for line in open(path, encoding="utf-8"):
    m = re.match(r"^([A-Z_0-9]+)=", line)
    if m and m.group(1) in repl:
        seen.add(m.group(1))
        out.append("%s=%s\n" % (m.group(1), repl[m.group(1)]))
    else:
        out.append(line)
for k, v in repl.items():
    if k not in seen:
        out.append("%s=%s\n" % (k, v))
open(path, "w", encoding="utf-8").writelines(out)
print("    đã ghi: " + ", ".join(repl))
PY
  fi

  cat <<EOF

$(printf '\033[1;36m==> Còn phải làm TAY\033[0m')
  1. Vercel → Project Settings → Environment Variables: đổi SUPABASE_URL và
     SUPABASE_SERVICE_ROLE_KEY sang project mới, rồi REDEPLOY (env chỉ nạp lúc build/boot).
  2. Kết nối lại 8 Facebook page ở /pages (bảng facebook_page trống — bạn chọn schema-only).
     Giữ nguyên TOKEN_ENC_KEY thì token dán vào mã hoá/giải mã như cũ.
  3. Tắt cron ở PROJECT CŨ để 2 project không cùng gọi Facebook/WordPress:
       select cron.unschedule(jobname) from cron.job where jobname like 'fb-dashboard-%';
  4. Worker cào đối thủ chạy ở laptop đọc .env.local — restart nó sau khi file đã đổi.
  5. Ảnh backup: bucket post-media ở project mới trống. post.image_backup_url của dữ liệu cũ
     không được chuyển (đúng theo lựa chọn schema-only) — bài mới sync sẽ tự backup lại.
EOF
fi

say "Xong."
