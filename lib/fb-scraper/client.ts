/**
 * Cào 1 page đối thủ: điều hướng bằng Chrome stealth, gom response /api/graphql/, parse ra
 * post + first-comment của chính page. Không có token Graph nên đây là đường duy nhất.
 */
import { type BrowserContext } from 'playwright';
import { launchStealth } from './browser';
import { scraperConfig } from './config';
import { parseFeed, type ParsedPost } from './parse';
import { competitorPageUrl } from '../fb-link';

const isNumeric = (h: string) => /^\d+$/.test(h);

// FB báo bị chặn (bot-detect / geo / audience). Ném lỗi rõ để worker ghi last_error.
const BLOCKED_MARKERS = [
  'bạn hiện không xem được nội dung này',
  'chỉ chia sẻ với một nhóm nhỏ',
  "you're temporarily blocked",
  "isn't available right now",
];

/**
 * Lỗi "chắc chắn không cào được" (geo-block / audience / bot-detect) — khác lỗi tạm thời
 * (mạng chập, timeout). Worker dựa vào đây để TẮT page ngay thay vì thử lại mỗi 6h.
 */
export class BlockedError extends Error {
  readonly blocked = true;
}

export interface ScrapedPage {
  handle: string;
  pageName: string | null;
  fbPageId: string | null;
  posts: ParsedPost[];
}

async function collectFeed(
  context: BrowserContext,
  handle: string,
  opts: { dumpPath?: string } = {},
): Promise<ScrapedPage> {
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

  await page.goto(competitorPageUrl(handle), { waitUntil: 'domcontentloaded', timeout: scraperConfig.timeoutMs });
  await page.waitForTimeout(3000);

  // Kiểm tra bị chặn NGAY (trước khi phí công scroll).
  const head = (await page.locator('body').innerText().catch(() => '')).slice(0, 3000).toLowerCase();
  if (BLOCKED_MARKERS.some((m) => head.includes(m))) {
    await page.close();
    throw new BlockedError(`Bị chặn khi mở "${handle}" (bot-detect/geo/audience) — thử VPN nước khác hoặc kiểm tra cookie`);
  }

  // Màn hình ĐẦU TIÊN không đi qua /api/graphql: FB nhúng thẳng JSON vào <script> của trang.
  // Chỉ nghe response GraphQL thì mất đúng mấy bài MỚI NHẤT (chỉ thấy từ trang 2 trở đi) —
  // nên phải bốc thêm JSON nhúng sẵn này.
  const inlineJson: string[] = await page
    .$$eval('script[type="application/json"]', (els) => els.map((e) => e.textContent ?? ''))
    .catch(() => []);
  for (const raw of inlineJson) {
    try {
      fragments.push(JSON.parse(raw));
    } catch {
      /* không phải JSON hợp lệ, bỏ */
    }
  }

  // Scroll để nạp thêm post + comment preview (mỗi vòng nghỉ cho GraphQL kịp trả).
  for (let i = 0; i < scraperConfig.scrollRounds; i++) {
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(1600);
  }

  // Đổ nguyên fragment ra đĩa để soi schema GraphQL thật (FB đổi field liên tục, không đoán được
  // link nằm ở đâu nếu chỉ nhìn dữ liệu đã parse). Chỉ dùng khi debug parser.
  if (opts.dumpPath) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(opts.dumpPath, JSON.stringify(fragments, null, 2));
    console.log(`  ↳ đã đổ ${fragments.length} fragment thô → ${opts.dumpPath}`);
  }

  const { posts, pageName, pageId } = parseFeed(fragments, isNumeric(handle) ? handle : null);
  await page.close();

  return {
    handle,
    pageName,
    fbPageId: pageId ?? (isNumeric(handle) ? handle : null),
    posts: recentFirst(posts, handle),
  };
}

/**
 * Bỏ bài quá cũ, sort mới→cũ rồi mới cắt maxPosts.
 * parseFeed trả theo thứ tự gặp trong fragment (không đảm bảo mới nhất trước) — nếu cắt trước khi
 * sort thì maxPosts slot có thể bị bài cũ chiếm hết.
 * Bài không rõ giờ (createdAt=null) bị loại vì không xác minh được tuổi; log riêng lý do để nếu FB
 * đổi schema (creation_time biến mất) thì lộ ra ngay trên console chứ không âm thầm mất sạch bài.
 */
function recentFirst(posts: ParsedPost[], handle: string): ParsedPost[] {
  const { maxAgeHours, maxPosts } = scraperConfig;
  let kept = posts;

  if (maxAgeHours > 0) {
    const cutoff = Date.now() / 1000 - maxAgeHours * 3600;
    const noTime = posts.filter((p) => p.createdAt === null).length;
    kept = posts.filter((p) => p.createdAt !== null && p.createdAt >= cutoff);
    const tooOld = posts.length - kept.length - noTime;
    if (tooOld || noTime) {
      console.log(`  ${handle}: bỏ ${tooOld} bài quá ${maxAgeHours}h, ${noTime} bài không rõ giờ`);
    }
  }

  return [...kept].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, maxPosts);
}

/** Cào 1 page (tự mở & đóng browser). Dùng cho chạy lẻ. */
export async function scrapeCompetitorPage(
  handle: string,
  opts: { dumpPath?: string } = {},
): Promise<ScrapedPage> {
  const { browser, context } = await launchStealth();
  try {
    return await collectFeed(context, handle, opts);
  } finally {
    await browser.close();
  }
}

/** Cào nhiều page trong CÙNG 1 browser (tiết kiệm, nghỉ delayMs giữa các page). */
export async function scrapeMany(
  handles: string[],
  onEach: (r: ScrapedPage | { handle: string; error: string; blocked: boolean }) => Promise<void>,
): Promise<void> {
  const { browser, context } = await launchStealth();
  try {
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      try {
        const r = await collectFeed(context, handle);
        await onEach(r);
      } catch (e) {
        await onEach({ handle, error: (e as Error).message, blocked: e instanceof BlockedError });
      }
      if (i < handles.length - 1) await new Promise((r) => setTimeout(r, scraperConfig.delayMs));
    }
  } finally {
    await browser.close();
  }
}
