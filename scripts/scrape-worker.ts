/**
 * Worker cào page đối thủ — chạy trên LAPTOP (không phải Vercel).
 *
 *   npx tsx --env-file=.env.local scripts/scrape-worker.ts            # daemon: cron 6h + poll đơn on-demand
 *   npx tsx --env-file=.env.local scripts/scrape-worker.ts --once     # cào tất cả page active 1 lần rồi thoát
 *   npx tsx --env-file=.env.local scripts/scrape-worker.ts --once <handle>   # cào đúng 1 handle (test)
 *   npx tsx --env-file=.env.local scripts/scrape-worker.ts --links    # CHỈ bóc link (mở permalink từng bài)
 *   npx tsx --env-file=.env.local scripts/scrape-worker.ts --dry <handle> --dump raw.json  # soi schema thô
 *
 * Cần .env.local: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + FB_SCRAPE_STORAGE_STATE.
 * Nhớ: bật VPN (nếu cần) + `caffeinate` để laptop không ngủ khi chạy daemon.
 */
import { createWorkerSupabase } from '../lib/fb-scraper/supabase';
import { scrapeAllActive, processScrapeRequests, scrapePages } from '../lib/fb-scraper/worker';
import { scraperConfig } from '../lib/fb-scraper/config';
import type { CompetitorPageRow } from '../lib/types';

async function runOnce(handle?: string) {
  const db = createWorkerSupabase();
  if (handle) {
    const { data, error } = await db.from('competitor_page').select('*').eq('handle', handle).single();
    if (error || !data) throw new Error(`Không thấy handle "${handle}" trong competitor_page (${error?.message ?? ''})`);
    await scrapePages(db, [data as CompetitorPageRow]);
  } else {
    await scrapeAllActive(db);
  }
}

async function runDaemon() {
  const cron = (await import('node-cron')).default;
  console.log(`[worker] daemon khởi động — cron 6h + poll mỗi ${scraperConfig.pollMs / 1000}s. Ctrl+C để dừng.`);

  // Cào toàn bộ active mỗi 6h.
  cron.schedule('0 */6 * * *', () => {
    scrapeAllActive().catch((e) => console.error('[cron] lỗi:', e.message));
  });

  // Poll đơn on-demand (nút "Cào ngay" trên Vercel).
  let busy = false;
  setInterval(async () => {
    if (busy) return; // tránh chồng lượt nếu lượt trước chưa xong
    busy = true;
    try {
      await processScrapeRequests();
    } catch (e) {
      console.error('[poll] lỗi:', (e as Error).message);
    } finally {
      busy = false;
    }
  }, scraperConfig.pollMs);

  // Cào 1 lượt ngay khi khởi động.
  await scrapeAllActive().catch((e) => console.error('[startup] lỗi:', e.message));
}

/**
 * Cào 1 page rồi CHỈ IN RA, không ghi DB, không lọc 6h — để soi worker thật sự thấy gì:
 * mỗi bài in giờ đăng + tuổi + đầu caption. Bài nào "giờ: không rõ" nghĩa là parser không
 * bắt được creation_time (bài đó sẽ bị bộ lọc 6h loại).
 */
async function runDry(handle: string, dumpPath?: string) {
  const { scrapeCompetitorPage } = await import('../lib/fb-scraper/client');
  const saved = scraperConfig.maxAgeHours;
  scraperConfig.maxAgeHours = 0; // tắt lọc để thấy TOÀN BỘ bài cào được
  try {
    const r = await scrapeCompetitorPage(handle, { dumpPath });
    console.log(`\n${r.pageName ?? handle} — ${r.posts.length} bài (chưa lọc):\n`);
    for (const p of r.posts) {
      const age = p.createdAt ? `${((Date.now() / 1000 - p.createdAt) / 3600).toFixed(1)}h trước` : '—';
      const when = p.createdAt ? new Date(p.createdAt * 1000).toLocaleString('vi-VN') : 'không rõ';
      const links = [...p.linkUrls, ...p.comments.flatMap((c) => c.linkUrls)];
      const linkTag = links.length ? ` [${links.length} link]` : '';
      console.log(
        `• ${when.padEnd(22)} ${age.padEnd(12)} ${(p.caption || '(không caption)').slice(0, 50).replace(/\n/g, ' ')}${linkTag}`,
      );
      for (const l of [...new Set(links)]) console.log(`      ↳ ${l}`);
    }
    const noTime = r.posts.filter((p) => !p.createdAt).length;
    if (noTime) console.log(`\n⚠ ${noTime}/${r.posts.length} bài không rõ giờ → sẽ bị bộ lọc ${saved}h loại.`);
    const noLink = r.posts.filter((p) => !p.linkUrls.length && !p.comments.some((c) => c.linkUrls.length)).length;
    console.log(`\n${r.posts.length - noLink}/${r.posts.length} bài bóc được ít nhất 1 link.`);
  } finally {
    scraperConfig.maxAgeHours = saved;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--dry')) {
    const handle = args.find((a) => !a.startsWith('--'));
    if (!handle) throw new Error('--dry cần 1 handle. VD: npm run worker:dry pacaropaamerica');
    // --dump <file>: đổ fragment GraphQL thô ra đĩa để soi schema (debug parser).
    const di = args.indexOf('--dump');
    const dumpPath = di >= 0 ? args[di + 1] : undefined;
    if (di >= 0 && !dumpPath) throw new Error('--dump cần đường dẫn file. VD: --dump /tmp/raw.json');
    await runDry(handle, dumpPath);
    process.exit(0);
  }
  // Chỉ chạy lượt bóc link (mở permalink từng bài), không cào lại feed. Dùng để backfill dần
  // đống bài cũ: chạy đi chạy lại, mỗi lượt ăn thêm postLinkLimit bài.
  if (args.includes('--links')) {
    const { scrapePostLinks } = await import('../lib/fb-scraper/worker');
    const r = await scrapePostLinks();
    console.log(`Xong: quét ${r.scanned} bài, ${r.found} bài có link.`);
    process.exit(0);
  }
  if (args.includes('--once')) {
    const handle = args.find((a) => !a.startsWith('--'));
    await runOnce(handle);
    process.exit(0);
  }
  await runDaemon();
}

main().catch((e) => { console.error('Lỗi:', e); process.exit(1); });
