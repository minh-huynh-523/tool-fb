import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateText, GeminiError, DEFAULT_MODEL } from './gemini';
import type { ScrapedArticle } from './scrape';

// Sinh bài viết WordPress trực tiếp từ caption FB của bài MÌNH + Part 2 (comment đã lên lịch sớm
// nhất) qua Gemini — đường thứ 2 bên cạnh "dán link ngoài -> cào" (lib/scrape.ts). Trả về ĐÚNG
// shape ScrapedArticle để cắm thẳng vào route/UI hiện có, không cần nhánh riêng ở downstream.

export class WpArticleGenError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'WpArticleGenError';
    this.status = status;
  }
}

const MAX_CAPTION_CHARS = 20_000;

function fillTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(caption|part2)\s*\}\}/gi, (_m, key: string) => vars[key.toLowerCase()] ?? '');
}

// Tiêu đề = đoạn mở đầu của CHÍNH caption gốc (nguyên văn) — KHÔNG nhờ Gemini đặt/diễn giải lại
// (model hay chịu paraphrase dù đã dặn). Đoạn = phần trước dòng trống đầu tiên; caption không có
// dòng trống thì lấy dòng đầu tiên.
function firstParagraph(caption: string): string {
  const normalized = caption.replace(/\r\n?/g, '\n').trim();
  const m = normalized.match(/^([\s\S]*?)\n\s*\n/);
  const para = m ? m[1] : (normalized.split('\n')[0] ?? normalized);
  return para.trim();
}

export async function generateWpArticleFromFb(db: SupabaseClient, postDbId: string): Promise<ScrapedArticle> {
  const { data: post, error: postErr } = await db
    .from('post')
    .select('message, permalink, image_backup_url')
    .eq('id', postDbId)
    .maybeSingle();
  if (postErr) throw new WpArticleGenError(postErr.message, 500);
  if (!post) throw new WpArticleGenError('Không tìm thấy post', 404);

  const caption = (post.message ?? '').trim();
  // Chặn sớm: không có caption thì không có gì để viết — đừng gọi API cho tốn tiền.
  if (!caption) throw new WpArticleGenError('Bài này không có caption để tạo bài viết', 400);

  const { data: tpl, error: tplErr } = await db
    .from('prompt_template')
    .select('body')
    .eq('kind', 'wp_article')
    .maybeSingle();
  if (tplErr) throw new WpArticleGenError(tplErr.message, 500);
  if (!tpl?.body?.trim()) {
    throw new WpArticleGenError('Chưa có mẫu bài viết — chạy migration 0023 trước', 400);
  }

  // Part 2 = comment đã lên lịch SỚM NHẤT cho bài này (run_after tăng dần) — tương tự "first
  // comment" mà ScheduleCommentButton dùng ở wordpress-post-button.tsx. Không có thì bỏ qua,
  // Gemini vẫn viết được từ mỗi caption.
  const { data: comment } = await db
    .from('scheduled_comment')
    .select('message')
    .eq('post_id', postDbId)
    .order('run_after', { ascending: true })
    .limit(1)
    .maybeSingle();
  const part2 = (comment?.message ?? '').trim();

  const story = caption.length > MAX_CAPTION_CHARS ? `${caption.slice(0, MAX_CAPTION_CHARS)}\n…(đã cắt)` : caption;
  const prompt = fillTemplate(tpl.body, { caption: story, part2 });

  let raw: string;
  try {
    raw = await generateText(prompt, { model: DEFAULT_MODEL });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new WpArticleGenError(msg, e instanceof GeminiError ? 502 : 500);
  }
  const contentHtml = raw.trim();
  if (!contentHtml) {
    throw new WpArticleGenError('Gemini trả về nội dung rỗng — thử lại', 502);
  }

  return {
    title: firstParagraph(caption),
    contentHtml,
    description: '',
    // CHỈ dùng ảnh đã backup vào Supabase Storage (post.media_url là link CDN của FB, hay hết
    // hạn/chặn hotlink — dùng thẳng sẽ có lúc WP tải ảnh lỗi âm thầm vì lúc publish link đã chết,
    // xem lib/post-image-backup.ts). Chưa backup xong thì bài WP tạm không có ảnh đại diện, KHÔNG
    // fallback về link FB gốc — enqueueWpContentCandidates() đã gate để không đẩy bài vào hàng đợi
    // trước khi backup được thử (xem lib/auto-publish.ts).
    imageUrl: post.image_backup_url ?? null,
    sourceUrl: post.permalink ?? '',
    parts: 1,
  };
}
