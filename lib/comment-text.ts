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
