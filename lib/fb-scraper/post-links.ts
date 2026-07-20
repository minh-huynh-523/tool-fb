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

export interface PostPageLinks {
  links: string[];
  /**
   * Trang có THẬT SỰ render nội dung bài không.
   *
   * Phân biệt "đã xem, bài không có link" với "chưa đọc được bài" — hai thứ này nhìn từ ngoài
   * giống hệt nhau (đều 0 link) nhưng xử lý ngược nhau: cái đầu đánh dấu đã quét cho khỏi mở lại,
   * cái sau PHẢI để nguyên cho lượt sau thử lại. Nhầm là mất im lặng cả loạt bài có link.
   *
   * Gặp thật: phiên đăng nhập rơi vào trạng thái nửa vời thì reel đâm vào tường đăng nhập, trả 0
   * link y như một bài sạch.
   *
   * Đếm div[role="article"] thay vì dò chữ "Đăng nhập": trang bài đọc được VẪN có chữ đó ở khung
   * bên (đã kiểm chứng — bài đối chứng vừa có chữ "Đăng nhập" vừa trả link đúng), nên dò chữ sẽ
   * giết nhầm đường đang chạy tốt. Bài render được luôn có ≥1 article (bài + comment); trang bị
   * chặn thì 0.
   */
  rendered: boolean;
}

/**
 * URL thật sự nên mở để đọc được comment.
 *
 * Trang /reel/<id>/ KHÔNG render comment (đã đo: article=0, link=0 trên mọi reel thử, kể cả khi
 * đã đăng nhập đầy đủ — bấm nút "Bình luận" cũng không ra link). Cùng video đó mở qua dạng
 * /{handle}/videos/<id>/ thì comment hiện bình thường (article=2) và link ra ngay.
 *
 * Chuyện này KHÔNG bỏ qua được: reel chiếm 27% số bài, mà mấy page đăng reel lại đúng là nhóm
 * xài chiêu thả link nhiều nhất (Stories She Carries 19/19 comment nhắc "full story", Yova Nika
 * 10/10, Pacas 11/11).
 */
export function readableUrl(permalink: string, handle?: string | null): string {
  const id = permalink.match(/\/reel\/(\d+)/)?.[1];
  if (!id) return permalink;
  // Có handle thì dùng /videos/ (ăn chắc nhất trong 3 dạng đã thử); không thì watch/?v= tự
  // chuyển hướng về đúng dạng đó, chỉ kém ổn định hơn chút.
  return handle
    ? `https://www.facebook.com/${handle}/videos/${id}/`
    : `https://www.facebook.com/watch/?v=${id}`;
}

/** Mở 1 bài, trả MỌI link nội dung thấy trong phần bài + comment. */
export async function linksFromPostPage(
  context: BrowserContext,
  permalink: string,
  opts: { handle?: string | null } = {},
): Promise<PostPageLinks> {
  const page = await context.newPage();
  const url = readableUrl(permalink, opts.handle);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: scraperConfig.timeoutMs });
    await page.waitForTimeout(4000); // chờ comment render (video lười hơn bài thường)

    const head = (await page.locator('body').innerText().catch(() => '')).slice(0, 2000).toLowerCase();
    if (BLOCKED_MARKERS.some((m) => head.includes(m))) {
      throw new BlockedError(`Bị chặn khi mở bài ${url}`);
    }

    const articles = await page.locator('div[role="article"]').count().catch(() => 0);

    // CHỈ quét trong div[role="article"] (bài + comment), không quét cả trang: phiên đăng nhập
    // đầy đủ render luôn thanh điều hướng của FB, kéo theo link giao diện như meta.ai vào kết quả.
    // Đã đo trên bài đối chứng: toàn trang 2 link (1 rác), trong article 1 link (đúng link thật).
    //
    // FB bọc MỌI link ngoài trong comment qua l.facebook.com/l.php?u=… — normalizeContentLink tự
    // bóc lớp bọc đó và loại luôn host của Meta lẫn host ảnh/GIF (giphy trong comment).
    const hrefs = await page
      .$$eval('div[role="article"] a[href]', (els) => els.map((e) => (e as HTMLAnchorElement).href))
      .catch(() => []);

    const links: string[] = [];
    for (const h of hrefs) {
      const u = normalizeContentLink(h);
      if (u && !links.includes(u)) links.push(u);
    }
    return { links, rendered: articles > 0 };
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
