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

/** URL trang của page đối thủ: ID số → profile.php, còn lại là vanity. */
export function competitorPageUrl(handle: string): string {
  return /^\d+$/.test(handle)
    ? `https://www.facebook.com/profile.php?id=${handle}`
    : `https://www.facebook.com/${handle}`;
}
