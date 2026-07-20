/**
 * Xử lý URL kiểu Facebook. Thuần logic (không import playwright/next) nên dùng được ở CẢ
 * worker cào lẫn component React.
 */

// Tham số theo dõi bám vào URL sau khi qua FB — bỏ đi để link copy ra sạch, dán đâu cũng được.
const TRACKING_PARAMS = ['fbclid', 'mibextid', '__tn__', '__cft__', 'extid'];

/**
 * Bóc link thật ra khỏi lớp bọc l.facebook.com.
 *
 * Link trong comment FB gần như luôn ở dạng
 *   https://l.facebook.com/l.php?u=<URL thật đã encode>&h=…&__tn__=…&c[0]=…
 * → dán nguyên si thì dài loằng ngoằng, mà mỗi page lại ra chuỗi khác nhau. Hàm này lấy
 * tham số `u`, decode, rồi bỏ nốt fbclid dính trong đó.
 *
 * URL không phải dạng bọc thì chỉ bị gỡ tham số theo dõi. Parse hỏng thì trả nguyên bản
 * (thà hiện link xấu còn hơn mất link).
 */
export function unwrapFbLink(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    let url = new URL(raw);
    if (/^(l|lm)\.facebook\.com$/i.test(url.hostname)) {
      const inner = url.searchParams.get('u');
      if (inner) url = new URL(inner);
    }
    for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
    return url.toString();
  } catch {
    return raw;
  }
}

// Host của Meta — link nội bộ (ảnh CDN, profile, permalink) không phải link nội dung cần theo dõi.
const FB_HOST =
  /(^|\.)(facebook\.com|fb\.com|fbcdn\.net|fbsbx\.com|fb\.watch|instagram\.com|whatsapp\.com|messenger\.com|threads\.net|meta\.com|oculus\.com)$/i;

// Host ảnh/GIF: comment kèm GIF sinh ra link giphy/tenor trong DOM — là media, không phải
// link bài viết. Không loại thì mỗi comment có GIF lại đẻ ra một "link" rác.
const MEDIA_HOST = /(^|\.)(giphy\.com|tenor\.com|gfycat\.com|imgur\.com|media\d*\.giphy\.com)$/i;

// Dấu câu dính đuôi khi URL nằm cuối câu: "…/story." hay "…/story»".
// CỐ Ý không có ) ] } ở đây — ngoặc phải xét theo cân bằng (URL kiểu Wikipedia
// ".../Foo_(bar)" có ngoặc hợp lệ), xử lý riêng ở vòng lặp bên dưới.
const TRAILING = /[.,;:!?"'”’»]+$/;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Chuẩn hoá 1 URL thô thành link NỘI DUNG, hoặc null nếu không phải.
 *
 * Dùng chung cho cả 2 đường lấy link (parse feed GraphQL và quét DOM trang bài) để hai bên
 * không lọc lệch nhau — cùng một link không thể lúc nhận lúc loại tuỳ đường nào tìm ra nó.
 */
export function normalizeContentLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Ngoặc/nháy mở dính đầu khi URL bị bọc trong câu: "(https://…)". Regex quét text không bao giờ
  // bắt được ký tự này, nhưng href lấy từ DOM hay chuỗi copy tay thì có.
  let u = raw.trim().replace(/^[([{<"'«]+/, '');
  // Gỡ dần đuôi: dấu câu cắt thẳng; ngoặc đóng chỉ cắt khi THỪA so với ngoặc mở (giữ nguyên
  // URL kiểu Wikipedia ".../Foo_(bar)"). Lặp vì hai loại có thể xen kẽ: "(…/Foo_(bar))."
  for (;;) {
    const trimmed = u.replace(TRAILING, '');
    if (trimmed !== u) {
      u = trimmed;
      continue;
    }
    const last = u.at(-1) ?? '';
    const open = CLOSERS[last];
    if (!open) break;
    const closes = u.split(last).length - 1;
    const opens = u.split(open).length - 1;
    if (closes <= opens) break;
    u = u.slice(0, -1);
  }
  const unwrapped = unwrapFbLink(u);
  try {
    const { hostname, protocol } = new URL(unwrapped);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    if (FB_HOST.test(hostname) || MEDIA_HOST.test(hostname)) return null;
    return unwrapped;
  } catch {
    return null;
  }
}

/** Mọi link nội dung trong 1 đoạn text (không chỉ cái đầu tiên). */
export function contentLinksInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const c = normalizeContentLink(m[0]);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** URL trang của page đối thủ: ID số → profile.php, còn lại là vanity. */
export function competitorPageUrl(handle: string): string {
  return /^\d+$/.test(handle)
    ? `https://www.facebook.com/profile.php?id=${handle}`
    : `https://www.facebook.com/${handle}`;
}

/**
 * MỌI link của 1 bài đối thủ: caption trước, rồi tới link trong từng comment (comment của page
 * trước — link "full story" thường nằm ở đó).
 *
 * Dùng chung cho bảng và nút export để hai chỗ không lệch nhau (trước đây cả hai cùng chép
 * `comments.find(c => c.link_url)`, tức chỉ hiện đúng 1 link/bài).
 *
 * unwrapFbLink chạy LẠI ở đây chứ không chỉ lúc cào: hàng cào từ trước khi có bước bóc link vẫn
 * hiện URL thật thay vì lớp bọc l.facebook.com — khỏi phải backfill DB.
 */
export function collectPostLinks(post: {
  caption_link_urls?: string[] | null;
  comment_link_urls?: string[] | null;
  comments: { link_url?: string | null; link_urls?: string[] | null; is_page_author?: boolean }[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | null | undefined) => {
    const u = unwrapFbLink(raw);
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  // comment_link_urls trước: đó là link "full story" lấy từ trang bài — thứ người dùng cần nhất.
  for (const u of post.comment_link_urls ?? []) add(u);
  for (const u of post.caption_link_urls ?? []) add(u);
  // Comment của page lên trước, giữ nguyên thứ tự trong từng nhóm.
  const ordered = [...post.comments].sort((a, b) => Number(b.is_page_author ?? true) - Number(a.is_page_author ?? true));
  for (const c of ordered) {
    // link_urls là nguồn chính; link_url là hàng cũ chưa backfill.
    if (c.link_urls?.length) for (const u of c.link_urls) add(u);
    else add(c.link_url);
  }
  return out;
}
