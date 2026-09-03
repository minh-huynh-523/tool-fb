/**
 * Gộp dòng trống thừa trong nội dung comment: mọi chuỗi ≥2 dòng trống liên tiếp → còn đúng 1 dòng trống.
 * Paste từ Word/Docs/bài viết hay dính cả trăm ngắt dòng — comment lên Facebook trông rất xấu.
 * Xuống dòng đơn giữ nguyên. Không trim hai đầu — API đã `.trim()` sẵn.
 */
export function collapseBlankLines(input: string): string {
  return input
    .replace(/\r\n?/g, "\n") // CRLF/CR (paste từ Word/Windows) → LF
    .replace(/[ \t]+$/gm, "") // bỏ space/tab cuối dòng để dòng "trắng" là dòng rỗng thật
    .replace(/\n{3,}/g, "\n\n"); // 3+ newline = ≥2 dòng trống → 1 dòng trống
}

/** Số dòng của comment — dùng chung cho form (đếm sống) và guard phía server. */
export function countLines(input: string): number {
  return input.replace(/\r\n?/g, "\n").split("\n").length;
}

/**
 * Ép comment xuống dưới trần số dòng của Facebook (xem FB_COMMENT_MAX_LINES) bằng cách GỘP ĐOẠN —
 * nối các dòng liền nhau bằng dấu cách cho tới khi đủ ít đoạn. KHÔNG cắt chữ nào: số từ trước và
 * sau luôn bằng nhau, chỉ đổi chỗ xuống dòng.
 *
 * `collapseBlankLines` KHÔNG thay được hàm này: nó chỉ gộp khi có ≥3 newline liên tiếp, mà văn bản
 * Gemini sinh (PART 2) đã là `\n\n` chuẩn rồi — 5.013 ký tự chia thành 126 đoạn, mỗi câu một dòng.
 * Vấn đề là SỐ ĐOẠN, không phải dòng trống thừa.
 *
 * Dòng đầu giữ riêng làm tiêu đề ("PART 2: ..."), phần còn lại chia đều. Giữ 1 dòng trống giữa các
 * đoạn cho dễ đọc ⇒ P đoạn tốn 2P-1 dòng, nên số đoạn tối đa là (maxLines+1)/2.
 */
export function limitCommentLines(input: string, maxLines: number): string {
  const collapsed = collapseBlankLines(input);
  if (countLines(collapsed) <= maxLines) return collapsed;

  const lines = collapsed.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return collapsed; // 1 đoạn khổng lồ không xuống dòng — gộp cũng vô ích

  const [header, ...rest] = lines;
  const maxParas = Math.max(2, Math.floor((maxLines + 1) / 2));
  const bodyParas = maxParas - 1; // trừ dòng tiêu đề
  const per = Math.ceil(rest.length / bodyParas);

  const paras: string[] = [];
  for (let i = 0; i < rest.length; i += per) paras.push(rest.slice(i, i + per).join(" "));
  return [header, ...paras].join("\n\n");
}
