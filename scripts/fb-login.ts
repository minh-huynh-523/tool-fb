/**
 * Đăng nhập Facebook bằng TAY (acc phụ) rồi lưu storageState để worker tái dùng.
 * Chạy 1 lần trên máy có màn hình. Cookie hết hạn (~vài tuần) thì chạy lại.
 *
 *   npx tsx scripts/fb-login.ts
 *
 * Lưu ý: KHÔNG dùng acc admin của page thật. Bật VPN trước nếu cần vào page bị geo-block.
 * File cookie lưu tại FB_SCRAPE_STORAGE_STATE (mặc định .fb-scraper/state.json) — đã gitignore.
 * Cũng gọi được từ nút "Đăng nhập lại" trên dashboard — xem lib/fb-scraper/login.ts.
 */
import { runFbLogin } from '../lib/fb-scraper/login';

async function main() {
  console.log('\n>>> Đang mở Chrome — đăng nhập ACC PHỤ (vượt hết challenge tới News Feed).');
  console.log('>>> Tự phát hiện đăng nhập xong, không cần bấm gì ở đây — chỉ thao tác trong cửa sổ Chrome.\n');
  const result = await runFbLogin();
  if (!result.ok) {
    console.error(`✗ ${result.message}`);
    process.exit(1);
  }
  console.log(`✓ ${result.message}`);
}

main().catch((e) => { console.error('Lỗi:', e); process.exit(1); });
