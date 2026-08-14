// Đăng comment "Full story: {permalink}" NGAY — bản đơn giản hoá của lib/comments.ts's
// drainOne() dành riêng cho auto-publish: chỉ cần gửi ĐÚNG 1 row vừa insert, không cần vòng quét
// claim/reclaim hàng loạt (đó vẫn là việc của cron process-comments trên Vercel, KHÔNG đụng tới —
// row insert ở đây vẫn nằm trong scheduled_comment nên process-comments vẫn thấy được nếu lỡ
// gửi hỏng ở đây, tự thử lại sau).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createPostComment, FacebookError } from "./facebook.ts";
import { decryptToken } from "./crypto.ts";

export async function postFullStoryComment(db: SupabaseClient, postId: string, permalink: string): Promise<boolean> {
  const message = `Full story: ${permalink}`;

  // Chặn trùng — cùng logic dedupe với POST /api/posts/[postDbId]/comments (Next.js).
  const { data: dup } = await db
    .from("scheduled_comment")
    .select("id")
    .eq("post_id", postId)
    .eq("message", message)
    .neq("status", "FAILED")
    .limit(1)
    .maybeSingle();
  if (dup) return true; // đã lên lịch/đã gửi rồi — coi như xong

  const { data: post } = await db.from("post").select("fb_post_id, page_id").eq("id", postId).maybeSingle();
  if (!post) return false;

  const { data: inserted, error: insErr } = await db
    .from("scheduled_comment")
    .insert({
      post_id: postId,
      fb_post_id: post.fb_post_id,
      page_id: post.page_id,
      message,
      run_after: new Date().toISOString(),
      status: "PROCESSING", // claim luôn — không cần bước PENDING riêng vì gửi ngay trong hàm này
      claimed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insErr) {
    // 23505 = vi phạm scheduled_comment_no_dup_idx — race với 1 lượt khác (Vercel manual run hoặc
    // nút "Đăng vào comment") vừa chèn Y HỆT message này trước 1 nhịp. ĐÃ CÓ comment rồi, không
    // phải lỗi thật — coi như xong. Xem lib/auto-publish.ts bản Next.js để biết lý do đầy đủ.
    if (insErr.code === "23505") return true;
    return false;
  }
  if (!inserted) return false;

  try {
    const { data: page, error: pageErr } = await db
      .from("facebook_page")
      .select("access_token")
      .eq("page_id", post.page_id)
      .maybeSingle();
    if (pageErr) throw new Error(pageErr.message);
    if (!page) throw new Error(`Không tìm thấy page ${post.page_id}`);

    const token = decryptToken(page.access_token);
    const result = await createPostComment(post.fb_post_id, token, { message });

    await db
      .from("scheduled_comment")
      .update({ status: "SENT", fb_comment_id: result.id, sent_at: new Date().toISOString(), error: null })
      .eq("id", inserted.id)
      .eq("status", "PROCESSING");
    return true;
  } catch (e) {
    const msg = e instanceof FacebookError ? e.message : e instanceof Error ? e.message : String(e);
    await db.from("scheduled_comment").update({ status: "FAILED", error: msg, attempts: 1 }).eq("id", inserted.id).eq("status", "PROCESSING");
    return false;
  }
}
