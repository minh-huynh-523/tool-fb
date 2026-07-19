/**
 * Cào 1 page đối thủ: điều hướng bằng Chrome stealth, gom response /api/graphql/, parse ra
 * post + first-comment của chính page. Không có token Graph nên đây là đường duy nhất.
 */
import { type BrowserContext } from 'playwright';
import { launchStealth } from './browser';
import { scraperConfig } from './config';
import { parseFeed, type ParsedPost } from './parse';

const isNumeric = (h: string) => /^\d+$/.test(h);
const pageUrl = (h: string) =>
  isNumeric(h) ? `https://www.facebook.com/profile.php?id=${h}` : `https://www.facebook.com/${h}`;

// FB báo bị chặn (bot-detect / geo / audience). Ném lỗi rõ để worker ghi last_error.
const BLOCKED_MARKERS = [
  'bạn hiện không xem được nội dung này',
  'chỉ chia sẻ với một nhóm nhỏ',
  "you're temporarily blocked",
  "isn't available right now",
];

export interface ScrapedPage {
  handle: string;
  pageName: string | null;
  fbPageId: string | null;
  posts: ParsedPost[];
}

async function collectFeed(context: BrowserContext, handle: string): Promise<ScrapedPage> {
  const page = await context.newPage();

  // Gom mọi fragment JSON từ response GraphQL (response FB nối nhiều JSON bằng '\n').
  const fragments: unknown[] = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/api/graphql/')) return;
    try {
      const text = await res.text();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          fragments.push(JSON.parse(t));
        } catch {
          /* dòng không phải JSON, bỏ */
        }
      }
    } catch {
      /* body không đọc được */
    }
  });

  await page.goto(pageUrl(handle), { waitUntil: 'domcontentloaded', timeout: scraperConfig.timeoutMs });
  await page.waitForTimeout(3000);

  // Kiểm tra bị chặn NGAY (trước khi phí công scroll).
  const head = (await page.locator('body').innerText().catch(() => '')).slice(0, 3000).toLowerCase();
  if (BLOCKED_MARKERS.some((m) => head.includes(m))) {
    await page.close();
    throw new Error(`Bị chặn khi mở "${handle}" (bot-detect/geo/audience) — thử VPN nước khác hoặc kiểm tra cookie`);
  }

  // Scroll để nạp thêm post + comment preview (mỗi vòng nghỉ cho GraphQL kịp trả).
  for (let i = 0; i < scraperConfig.scrollRounds; i++) {
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(1600);
  }

  const { posts, pageName, pageId } = parseFeed(fragments, isNumeric(handle) ? handle : null);
  await page.close();

  return {
    handle,
    pageName,
    fbPageId: pageId ?? (isNumeric(handle) ? handle : null),
    posts: posts.slice(0, scraperConfig.maxPosts),
  };
}

/** Cào 1 page (tự mở & đóng browser). Dùng cho chạy lẻ. */
export async function scrapeCompetitorPage(handle: string): Promise<ScrapedPage> {
  const { browser, context } = await launchStealth();
  try {
    return await collectFeed(context, handle);
  } finally {
    await browser.close();
  }
}

/** Cào nhiều page trong CÙNG 1 browser (tiết kiệm, nghỉ delayMs giữa các page). */
export async function scrapeMany(
  handles: string[],
  onEach: (r: ScrapedPage | { handle: string; error: string }) => Promise<void>,
): Promise<void> {
  const { browser, context } = await launchStealth();
  try {
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      try {
        const r = await collectFeed(context, handle);
        await onEach(r);
      } catch (e) {
        await onEach({ handle, error: (e as Error).message });
      }
      if (i < handles.length - 1) await new Promise((r) => setTimeout(r, scraperConfig.delayMs));
    }
  } finally {
    await browser.close();
  }
}
