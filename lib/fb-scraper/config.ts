/**
 * Cấu hình worker cào FB (đọc env). KHÔNG dùng `import 'server-only'` vì chạy bằng tsx/Node ở laptop.
 * Env đặt trong .env.local của laptop (xem .env.example các key FB_SCRAPE_*).
 */
import { resolve } from 'node:path';

export const scraperConfig = {
  // Đường dẫn file storageState (cookie đăng nhập acc phụ). Sinh bằng scripts/fb-login.ts.
  storageState: process.env.FB_SCRAPE_STORAGE_STATE
    ? resolve(process.env.FB_SCRAPE_STORAGE_STATE)
    : resolve('.fb-scraper/state.json'),
  // Mặc định chạy ẩn; HEADFUL=1 để hiện cửa sổ (debug / login).
  headless: process.env.HEADFUL !== '1',
  timeoutMs: Number(process.env.FB_SCRAPE_TIMEOUT_MS ?? 45_000),
  maxPosts: Number(process.env.FB_SCRAPE_MAX_POSTS ?? 10),
  // Chỉ giữ bài đăng trong N giờ đổ lại (khớp chu kỳ cron 6h). 0 = tắt lọc (cào bù lịch sử).
  maxAgeHours: Number(process.env.FB_SCRAPE_MAX_AGE_HOURS ?? 0),
  scrollRounds: Number(process.env.FB_SCRAPE_SCROLL ?? 6),
  delayMs: Number(process.env.FB_SCRAPE_DELAY_MS ?? 8_000), // nghỉ giữa các page (chống rate-limit)
  pollMs: Number(process.env.FB_SCRAPE_POLL_MS ?? 60_000), // chu kỳ poll đơn on-demand
  // Optional: proxy per-context (thay VPN toàn máy). VD http://user:pass@host:port
  proxy: process.env.FB_SCRAPE_PROXY || '',

  // --- Lượt bóc link: mở permalink TỪNG bài (feed không chứa link "full story") ---
  // Trần số bài mỗi lượt. Đo thật ~10-14s/bài ⇒ 60 bài ≈ 10-14 phút. Không có trần thì lượt
  // backfill đầu (hàng trăm bài) sẽ chạy lê thê và ăn chặn giữa chừng.
  postLinkLimit: Number(process.env.FB_SCRAPE_POST_LINK_LIMIT ?? 60),
  postLinkDelayMinMs: Number(process.env.FB_SCRAPE_POST_LINK_DELAY_MIN_MS ?? 3_000),
  postLinkDelayMaxMs: Number(process.env.FB_SCRAPE_POST_LINK_DELAY_MAX_MS ?? 8_000),
  // Bài mới hơn ngần này giờ thì quét LẠI dù đã quét: đối thủ hay thả link vài giờ sau khi đăng.
  // Bài cũ hơn mà đã quét thì thôi — không bao giờ đụng lại, để lượt sau còn slot cho bài mới.
  postLinkRescanHours: Number(process.env.FB_SCRAPE_POST_LINK_RESCAN_HOURS ?? 24),
};

// Playwright cần proxy dạng { server, username, password } — parse từ URL.
export function parseProxy(raw: string): { server: string; username?: string; password?: string } | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username || undefined,
      password: u.password || undefined,
    };
  } catch {
    return { server: raw };
  }
}
