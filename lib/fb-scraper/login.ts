/**
 * Đăng nhập FB bằng tay (mở Chrome headful thật) rồi lưu storageState — dùng chung cho CLI
 * (scripts/fb-login.ts) lẫn nút "Đăng nhập lại" gọi từ dashboard (app/api/scraper/relogin).
 *
 * Tự phát hiện đăng nhập XONG bằng cookie `c_user` (FB set cookie này ngay khi login thành công,
 * dùng để nhận diện user đang đăng nhập) — KHÔNG cần bấm Enter ở terminal như bản cũ, nên gọi được
 * từ API route (không có TTY để đọc phím).
 *
 * CHỈ chạy được ở máy có màn hình thật (dev local) — Vercel serverless không có GUI, gọi hàm này
 * ở đó sẽ throw ngay từ chromium.launch() (channel:'chrome' đòi hỏi Chrome cài sẵn + display).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { scraperConfig } from './config';

export interface FbLoginResult {
  ok: boolean;
  message: string;
}

export async function runFbLogin(opts: { timeoutMs?: number } = {}): Promise<FbLoginResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000; // 5 phút để tự tay đăng nhập + qua 2FA/challenge
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'vi-VN' });
    const page = await context.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cookies = await context.cookies('https://www.facebook.com');
      if (cookies.some((c) => c.name === 'c_user')) {
        mkdirSync(dirname(scraperConfig.storageState), { recursive: true });
        await context.storageState({ path: scraperConfig.storageState });
        return { ok: true, message: `Đã lưu phiên đăng nhập → ${scraperConfig.storageState}` };
      }
      await page.waitForTimeout(2000);
    }
    return { ok: false, message: 'Hết 5 phút chờ mà chưa thấy đăng nhập xong — thử lại.' };
  } finally {
    await browser.close();
  }
}
