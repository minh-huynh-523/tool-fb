/**
 * Mốc "bây giờ" (ms). Chỉ dùng trong SERVER COMPONENT — nơi mỗi request render đúng một lần
 * nên đọc đồng hồ là an toàn. Bọc thành hàm vì React Compiler chặn `Date.now()` viết thẳng
 * trong thân component (rule react-hooks/purity).
 *
 * CLIENT component thì KHÔNG dùng hàm này — server và client sẽ ra hai giờ khác nhau, lệch
 * hydration; bên đó dùng useNow().
 */
export function nowMs(): number {
  return Date.now();
}

// Mốc đầu ngày theo giờ Việt Nam (UTC+7, không DST), trả về ISO (UTC) để so với cột timestamptz.
export function startOfTodayVNISO(): string {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 3600 * 1000); // dịch sang giờ VN
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth();
  const d = vn.getUTCDate();
  const utcMs = Date.UTC(y, m, d, 0, 0, 0) - 7 * 3600 * 1000; // nửa đêm VN quy về UTC
  return new Date(utcMs).toISOString();
}

// Mốc 1 GIỜ CỤ THỂ của HÔM NAY theo giờ VN (UTC+7) -> ISO (UTC). VD hourTodayVNISO(12) = 12h
// trưa hôm nay. Cùng idiom với startOfTodayVNISO(), chỉ khác giờ trong ngày thay vì luôn 00:00.
export function hourTodayVNISO(hour: number): string {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 3600 * 1000); // dịch sang giờ VN
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth();
  const d = vn.getUTCDate();
  const utcMs = Date.UTC(y, m, d, hour, 0, 0) - 7 * 3600 * 1000; // giờ cắt hôm nay (VN) quy về UTC
  return new Date(utcMs).toISOString();
}

// Mốc đầu ngày (00:00 giờ VN) của 1 ngày "YYYY-MM-DD" -> ISO (UTC).
export function startOfDayVNISO(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const utcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - 7 * 3600 * 1000;
  return new Date(utcMs).toISOString();
}

// Mốc cuối ngày (23:59:59.999 giờ VN) của 1 ngày "YYYY-MM-DD" -> ISO (UTC).
export function endOfDayVNISO(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const utcMs = Date.UTC(y, m - 1, d, 23, 59, 59, 999) - 7 * 3600 * 1000;
  return new Date(utcMs).toISOString();
}

// "YYYY-MM-DDTHH:mm" (coi là giờ VN, UTC+7) -> ISO UTC. Dùng cho lên lịch comment.
export function vnLocalToISO(local: string): string {
  const [datePart, timePart] = local.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = (timePart ?? "00:00").split(":").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0) - 7 * 3600 * 1000;
  return new Date(utcMs).toISOString();
}

// ISO UTC -> "YYYY-MM-DDTHH:mm" theo giờ VN (UTC+7). Ngược với vnLocalToISO — dùng để
// đổ giá trị run_after vào DateTimePicker khi sửa lịch.
export function isoToVnLocal(iso: string): string {
  const vn = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${vn.getUTCFullYear()}-${p(vn.getUTCMonth() + 1)}-${p(vn.getUTCDate())}T${p(vn.getUTCHours())}:${p(vn.getUTCMinutes())}`;
}

/**
 * Khoảng cách thời gian dạng người đọc: "vừa xong" / "12 phút trước" / "3 giờ trước".
 * Nhận `now` từ ngoài (thay vì gọi Date.now()) để hàm thuần — component lấy now qua useNow().
 */
export function relativeVN(iso: string | null, now: number): string {
  if (!iso) return "—";
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms < 0) return "sắp tới"; // giờ máy lệch, hoặc FB trả giờ tương lai
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "vừa xong";
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

// Format hiển thị ngắn theo giờ VN.
export function formatVN(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  } catch {
    return iso;
  }
}
