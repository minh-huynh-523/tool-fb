/**
 * Bóc link "full story" bằng cách mở PERMALINK từng bài.
 *
 * Vì sao phải mở riêng từng bài thay vì đọc feed: đã dump fragment GraphQL của feed 2 lượt
 * (89 và 91 fragment) — KHÔNG có comment node nào mang link, không có `ranges`, và URL ngoài duy
 * nhất trong payload là blocklist nội bộ của FB. Feed đơn giản là không chứa link đó. Mở đúng
 * trang bài thì link hiện ngay trong DOM dưới dạng bọc `l.facebook.com/l.php?u=…`.
 *
 * Không cần bấm đổi bộ lọc sang "All comments" (đã thử cả 2 chiều, kết quả như nhau) — dù chính
 * comment của đối thủ hướng dẫn người đọc làm vậy.
 */
import { type BrowserContext } from 'playwright';
import { normalizeContentLink } from '../fb-link';
import { scraperConfig } from './config';
import { BlockedError } from './client';

const BLOCKED_MARKERS = [
  'bạn hiện không xem được nội dung này',
  "you're temporarily blocked",
  "isn't available right now",
  'tạm thời bị chặn',
];

/** Mở 1 permalink, trả MỌI link nội dung thấy trong DOM (chủ yếu từ comment). */
export async function linksFromPostPage(context: BrowserContext, permalink: string): Promise<string[]> {
  const page = await context.newPage();
  try {
    await page.goto(permalink, { waitUntil: 'domcontentloaded', timeout: scraperConfig.timeoutMs });
    await page.waitForTimeout(3500); // chờ comment render

    const head = (await page.locator('body').innerText().catch(() => '')).slice(0, 2000).toLowerCase();
    if (BLOCKED_MARKERS.some((m) => head.includes(m))) {
      throw new BlockedError(`Bị chặn khi mở bài ${permalink}`);
    }

    // FB bọc MỌI link ngoài trong comment qua l.facebook.com/l.php?u=… — normalizeContentLink
    // tự bóc lớp bọc đó và loại luôn host của Meta lẫn host ảnh/GIF (giphy trong comment).
    const hrefs = await page
      .$$eval('a[href]', (els) => els.map((e) => (e as HTMLAnchorElement).href))
      .catch(() => []);

    const out: string[] = [];
    for (const h of hrefs) {
      const u = normalizeContentLink(h);
      if (u && !out.includes(u)) out.push(u);
    }
    return out;
  } finally {
    await page.close();
  }
}

// Nghỉ NGẪU NHIÊN giữa các bài: mở đều tăm tắp đúng N giây là dấu hiệu bot rõ nhất, mà lượt này
// tải trang liên tục trên cùng một phiên đăng nhập nên rất dễ ăn chặn.
export function randomDelayMs(): number {
  const { postLinkDelayMinMs: lo, postLinkDelayMaxMs: hi } = scraperConfig;
  return lo + Math.floor(Math.random() * Math.max(1, hi - lo));
}
