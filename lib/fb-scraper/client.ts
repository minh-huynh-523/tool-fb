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
 * Phiên đăng nhập (.fb-scraper/state.json) đã hết hạn — FB trả "màn login wall" (chỉ hiện 1 bài
 * công khai) thay vì feed thật. Bug thật đã gặp: page vẫn active, collectFeed() vẫn "chạy được"
 * (không khớp BLOCKED_MARKERS) nhưng chỉ ra đúng 1 bài — âm thầm ghi dữ liệu THIẾU vào DB như thể
 * đó là toàn bộ feed. Marker riêng, KHÁC BLOCKED_MARKERS: đây là lỗi phiên (sửa được bằng đăng nhập
 * lại), không phải page bị chặn (sửa bằng VPN/tắt page).
 */
const LOGIN_WALL_MARKERS = ['bạn quên tài khoản ư?'];

/**
 * Lỗi "chắc chắn không cào được" (geo-block / audience / bot-detect) — khác lỗi tạm thời
 * (mạng chập, timeout). Worker dựa vào đây để TẮT page ngay thay vì thử lại mỗi 6h.
 */
export class BlockedError extends Error {
  readonly blocked = true;
}

/**
 * Phiên FB dùng để cào đã hết hạn — ảnh hưởng CẢ BATCH (mọi page dùng chung 1 browser context/
 * cookie), không phải lỗi riêng của 1 page. Worker dựa vào đây để: dừng cả lượt ngay (cào tiếp
 * page khác chỉ tổ phí thời gian), KHÔNG đốt fail_count/tắt page, và báo FE yêu cầu đăng nhập lại.
 */
export class SessionExpiredError extends Error {
  readonly sessionExpired = true;
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
  opts: { dumpPath?: string; maxAgeHours?: number } = {},
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

  // Kiểm tra bị chặn / hết phiên NGAY (trước khi phí công scroll).
  const head = (await page.locator('body').innerText().catch(() => '')).slice(0, 3000).toLowerCase();
  if (LOGIN_WALL_MARKERS.some((m) => head.includes(m))) {
    await page.close();
    throw new SessionExpiredError(`Phiên đăng nhập FB đã hết hạn khi mở "${handle}" — chạy lại: npm run fb-login`);
  }
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
  //
  // KHÔNG dùng mouse.wheel / window.scrollBy: <body> của FB KHÔNG cuộn (đo được scrollHeight ===
  // innerHeight === 900), feed nằm trong một DIV cuộn riêng. Đã thử cả 4 cách — mouse.wheel,
  // window.scrollBy, scrollTo(bottom), phím End — window.scrollY đứng im ở 0 và số bài parse được
  // y hệt nhau ở 0, 6 và 20 vòng. Tức vòng lặp cũ là no-op hoàn toàn.
  // Cách chạy được: tìm phần tử cuộn cao nhất rồi đẩy scrollTop của CHÍNH nó.
  for (let i = 0; i < scraperConfig.scrollRounds; i++) {
    const moved = await page.evaluate(() => {
      const el = [...document.querySelectorAll<HTMLElement>('*')]
        .filter((e) => e.scrollHeight > e.clientHeight + 200)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = el.scrollHeight;
      return el.scrollTop > before;
    });
    await page.waitForTimeout(1600);
    if (!moved) break; // chạm đáy (hoặc không có gì cuộn được) -> đừng phí thêm vòng
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
    posts: recentFirst(posts, handle, opts.maxAgeHours),
  };
}

/**
 * Bỏ bài quá cũ, sort mới→cũ rồi mới cắt maxPosts.
 * parseFeed trả theo thứ tự gặp trong fragment (không đảm bảo mới nhất trước) — nếu cắt trước khi
 * sort thì maxPosts slot có thể bị bài cũ chiếm hết.
 * Bài không rõ giờ (createdAt=null) bị loại vì không xác minh được tuổi; log riêng lý do để nếu FB
 * đổi schema (creation_time biến mất) thì lộ ra ngay trên console chứ không âm thầm mất sạch bài.
 */
function recentFirst(
  posts: ParsedPost[],
  handle: string,
  maxAgeHours = scraperConfig.maxAgeHours,
): ParsedPost[] {
  const { maxPosts } = scraperConfig;
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

  const sorted = [...kept].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (maxPosts <= 0) return sorted; // <=0 = giữ hết

  const cut = sorted.slice(0, maxPosts);
  // Chạm trần phải LA LÊN: bài bị cắt ở đây là bài đã scroll + parse xong, vứt đi là mất hẳn cho
  // tới lượt sau (và nếu page đăng dày thì lượt sau cũng không với tới). Im lặng thì mất bài mà
  // nhìn UI không tài nào biết — đúng cái đã xảy ra với trần 10 cũ.
  if (sorted.length > cut.length) {
    console.warn(
      `  ${handle}: CHẠM TRẦN maxPosts=${maxPosts} — bỏ ${sorted.length - cut.length}/${sorted.length} bài. Nâng FB_SCRAPE_MAX_POSTS.`,
    );
  }
  return cut;
}

/** Cào 1 page (tự mở & đóng browser). Dùng cho chạy lẻ. */
export async function scrapeCompetitorPage(
  handle: string,
  opts: { dumpPath?: string; maxAgeHours?: number } = {},
): Promise<ScrapedPage> {
  const { browser, context } = await launchStealth();
  try {
    return await collectFeed(context, handle, opts);
  } finally {
    await browser.close();
  }
}

export interface ScrapeManyOpts {
  dumpPath?: string;
  maxAgeHours?: number;
}

/** Cào nhiều page trong CÙNG 1 browser (tiết kiệm, nghỉ delayMs giữa các page). */
export async function scrapeMany(
  handles: string[],
  onEach: (
    r: ScrapedPage | { handle: string; error: string; blocked: boolean; sessionExpired?: boolean },
  ) => Promise<void>,
  opts: ScrapeManyOpts = {},
): Promise<void> {
  const { browser, context } = await launchStealth();
  try {
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      try {
        const r = await collectFeed(context, handle, opts);
        await onEach(r);
      } catch (e) {
        const sessionExpired = e instanceof SessionExpiredError;
        await onEach({ handle, error: (e as Error).message, blocked: e instanceof BlockedError, sessionExpired });
        // Phiên đã chết là chuyện của CẢ browser context (cùng cookie cho mọi page) — cào tiếp
        // page khác trong CÙNG phiên chỉ tổ phí thời gian (và dễ bị soi thêm), dừng cả batch luôn.
        if (sessionExpired) break;
      }
      if (i < handles.length - 1) await new Promise((r) => setTimeout(r, scraperConfig.delayMs));
    }
  } finally {
    await browser.close();
  }
}
