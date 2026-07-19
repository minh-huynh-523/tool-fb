/**
 * Mở Chrome THẬT với cấu hình "stealth" để FB không nhận diện bot.
 * Phát hiện ở spike: Chromium bundled + cờ automation → FB trả màn "Bạn hiện không xem được nội dung này".
 * Chrome thật (channel:chrome) + tắt AutomationControlled + ẩn navigator.webdriver → vào được.
 */
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { scraperConfig, parseProxy } from './config';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function launchStealth(): Promise<{ browser: Browser; context: BrowserContext }> {
  const proxy = parseProxy(scraperConfig.proxy);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: scraperConfig.headless,
    args: ['--disable-blink-features=AutomationControlled'],
    ...(proxy ? { proxy } : {}),
  });
  const context = await browser.newContext({
    storageState: scraperConfig.storageState,
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { browser, context };
}
