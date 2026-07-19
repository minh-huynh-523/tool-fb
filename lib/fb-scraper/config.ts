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
  maxAgeHours: Number(process.env.FB_SCRAPE_MAX_AGE_HOURS ?? 6),
  scrollRounds: Number(process.env.FB_SCRAPE_SCROLL ?? 6),
  delayMs: Number(process.env.FB_SCRAPE_DELAY_MS ?? 8_000), // nghỉ giữa các page (chống rate-limit)
  pollMs: Number(process.env.FB_SCRAPE_POLL_MS ?? 60_000), // chu kỳ poll đơn on-demand
  // Optional: proxy per-context (thay VPN toàn máy). VD http://user:pass@host:port
  proxy: process.env.FB_SCRAPE_PROXY || '',
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
