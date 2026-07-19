/**
 * Đăng nhập Facebook bằng TAY (acc phụ) rồi lưu storageState để worker tái dùng.
 * Chạy 1 lần trên laptop (cần màn hình). Cookie hết hạn (~vài tuần) thì chạy lại.
 *
 *   npx tsx scripts/fb-login.ts
 *
 * Lưu ý: KHÔNG dùng acc admin của page thật. Bật VPN trước nếu cần vào page bị geo-block.
 * File cookie lưu tại FB_SCRAPE_STORAGE_STATE (mặc định .fb-scraper/state.json) — đã gitignore.
 */
import { chromium } from 'playwright';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { scraperConfig } from '../lib/fb-scraper/config';

function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(prompt, () => { rl.close(); res(); }));
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'vi-VN' });
  const page = await context.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

  console.log('\n>>> Đăng nhập ACC PHỤ trên cửa sổ Chrome (vượt hết challenge tới News Feed).');
  await waitForEnter('>>> Xong thì bấm ENTER... ');

  mkdirSync(dirname(scraperConfig.storageState), { recursive: true });
  await context.storageState({ path: scraperConfig.storageState });
  console.log(`\n✓ Đã lưu cookie → ${scraperConfig.storageState}`);
  await browser.close();
}

main().catch((e) => { console.error('Lỗi:', e); process.exit(1); });
