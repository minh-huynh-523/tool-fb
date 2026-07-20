/**
 * Ngưỡng để một bài FB nổi lên hàng đợi "Cần đăng link WP".
 *
 * Để RIÊNG khỏi lib/queries.ts vì cùng lý do với lib/sheet-state.ts: queries.ts kéo theo
 * lib/supabase/admin có `import 'server-only'`, mà badge/filter là client component.
 *
 * File này CỐ Ý không đọc process.env: env không có tiền tố NEXT_PUBLIC_ sẽ inline thành
 * undefined trong client bundle, nên nếu đọc ở đây thì server và client sẽ âm thầm chạy hai
 * bộ default khác nhau. Việc đọc env nằm ở envThresholds() trong lib/queries.ts (server-only).
 */
export interface AttentionThresholds {
  minReactions: number; // bài phải có SỐ REACTION LỚN HƠN số này
  minComments: number; // ... HOẶC số comment TỪ số này trở lên
}

/**
 * minReactions = 10: con số user chốt.
 *
 * minComments = 5 chứ không phải 4: `post.comment_count` lấy từ comments.summary.total_count nên
 * TÍNH CẢ comment của chính page. Workflow luôn có 1 first comment ở mỗi bài, và ở đúng tập bài
 * ta đang lọc thì offset này chắc chắn bằng 1 — comment "Full story" theo định nghĩa chưa tồn tại
 * (chưa có scraped_article). `page_commented` chỉ là boolean nên không trừ chính xác được, nên
 * hấp thụ offset vào default và nói rõ trên UI: 5 ≈ 4 comment thật của người ngoài.
 */
export const WP_ATTENTION_DEFAULTS: AttentionThresholds = { minReactions: 10, minComments: 5 };

const MAX = 10_000; // chặn số vô nghĩa từ URL; cao hơn mọi bài thật nên không cản dùng thật

function toInt(v: unknown, fallback: number, min: number): number {
  // PHẢI bắt rỗng/thiếu TRƯỚC khi ép số: Number('') === 0 (không phải NaN), nên nếu chỉ dựa vào
  // Number.isFinite thì env thiếu -> ngưỡng sập về 0 và hàng đợi nuốt gần như mọi bài đã đăng.
  // Đây đúng là ca mặc định (env chưa khai báo), không phải ca hiếm.
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  if (s === '') return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX, Math.max(min, Math.trunc(n)));
}

/**
 * Chuẩn hoá ngưỡng đến từ env hoặc searchParams (đều là chuỗi người dùng nhập được).
 * Hai giá trị này bị nội suy thẳng vào filter string của PostgREST `.or(...)`, nên ép về
 * số nguyên ở ĐÂY chính là chốt chặn injection — đừng bỏ bước này ở phía gọi.
 */
export function clampThresholds(reactions: unknown, comments: unknown): AttentionThresholds {
  return {
    minReactions: toInt(reactions, WP_ATTENTION_DEFAULTS.minReactions, 0),
    // min 1: minComments = 0 sẽ kéo về mọi bài đã đăng, hàng đợi thành vô dụng.
    minComments: toInt(comments, WP_ATTENTION_DEFAULTS.minComments, 1),
  };
}

export function thresholdLabel(t: AttentionThresholds): string {
  return `> ${t.minReactions} reaction hoặc ≥ ${t.minComments} comment`;
}
