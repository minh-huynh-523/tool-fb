/**
 * Trần độ dài comment của Facebook.
 *
 * Graph không trả lỗi nào nói rõ "quá dài" — vượt trần thì rơi vào code 100 (tham số sai), mà
 * lúc đó comment đã nằm trong hàng đợi hàng giờ rồi mới fail âm thầm. Chặn ngay từ lúc nhập.
 *
 * 8.000 là con số Meta công bố cho comment (post là 63.206). Đối chiếu dữ liệu thật của dự án:
 * comment dài nhất đăng THÀNH CÔNG là 7.602 ký tự, và ca fail duy nhất do độ dài là 11.578 —
 * khớp với trần này.
 */
export const FB_COMMENT_MAX_CHARS = 8000;

/**
 * Trần SỐ DÒNG của comment Facebook.
 *
 * Không có tài liệu nào của Meta nói tới giới hạn này, và Graph báo lỗi hoàn toàn mù mờ:
 * `[FB 1/1446042] An unknown error occurred (trace ...)` — không nhắc gì tới dòng hay định dạng,
 * nên rất dễ tưởng là lỗi mạng tạm thời rồi retry mãi (đã mất 1 buổi vì tưởng vậy).
 *
 * Đối chiếu dữ liệu thật của dự án (2026-09-03), tách bạch tuyệt đối, không có vùng chồng lấn:
 *   - 249 comment ĐĂNG THÀNH CÔNG: tối đa 100 dòng (99 ký tự xuống dòng).
 *   - 6 comment FAIL với đúng subcode 1446042: 104, 132, 134, 159, 198, 252 dòng.
 * Đây KHÔNG phải trần độ dài trá hình: comment 7.044 ký tự đã đăng được, còn comment 2.575 ký tự
 * bị từ chối — biến quyết định là số dòng, không phải số ký tự.
 *
 * Lấy đúng mốc 100 vì đó là giá trị lớn nhất ĐÃ CHỨNG MINH gửi được; ngưỡng thật của Facebook nằm
 * đâu đó trong khoảng 101–103 nhưng không có bằng chứng nên không nới thêm.
 */
export const FB_COMMENT_MAX_LINES = 100;
