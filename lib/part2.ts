// "Part 2" của 1 bài đối thủ: ƯU TIÊN comment thật do chính page đăng (cào được), chỉ dùng bản
// Gemini sinh từ caption (part2_generated, xem lib/fb-scraper/part2-fallback.ts) khi bài không có
// comment nào của page. Gom về 1 chỗ vì trước đây logic lọc is_page_author bị chép tay 3 nơi
// (competitor-posts-table.tsx, export-sheet-button.tsx, lib/competitor-prompt.ts) — bản trong
// competitor-prompt.ts còn thiếu filter is_page_author, lẫn cả comment người ngoài vào Part 2.

export interface Part2 {
  text: string;
  source: 'scraped' | 'generated' | null;
}

export function getPart2(
  comments: { is_page_author: boolean; message: string | null }[],
  post: { part2_generated: string | null },
): Part2 {
  const scraped = comments
    .filter((c) => c.is_page_author)
    .map((c) => (c.message ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
  if (scraped) return { text: scraped, source: 'scraped' };

  const generated = (post.part2_generated ?? '').trim();
  if (generated) return { text: generated, source: 'generated' };

  return { text: '', source: null };
}
