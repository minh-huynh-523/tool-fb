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
