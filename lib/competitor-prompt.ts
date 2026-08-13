import 'server-only';
import { createSupabaseAdmin } from './supabase/admin';
import { generateText, GeminiError, DEFAULT_MODEL } from './gemini';
import { splitPromptSections } from './prompt-sections';
import { getPart2 } from './part2';

// Sinh prompt ảnh + prompt video cho 1 bài đối thủ:
//   caption (+ part 2) -> mega-prompt trong bảng prompt_template -> Gemini (1 lần gọi)
//   -> splitPromptSections -> lưu vào competitor_post.
// Đầu vào là CAPTION FB (chốt với user) — không kéo toàn văn bài WordPress.

export interface PromptResult {
  storyAnalysis: string | null;
  promptImage: string | null;
  promptVideo: string | null;
  promptRaw: string;
  promptError: string | null;
  promptModel: string;
  promptAt: string;
}

// Lỗi "không sinh được gì" — route đổi thành HTTP 4xx/502 với message đọc được.
export class PromptError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PromptError';
    this.status = status;
  }
}

const MAX_CAPTION_CHARS = 60_000;

function fillTemplate(body: string, vars: Record<string, string>): { text: string; used: boolean } {
  let used = false;
  const text = body.replace(/\{\{\s*(caption|part2|link|title)\s*\}\}/gi, (_m, key: string) => {
    used = true;
    return vars[key.toLowerCase()] ?? '';
  });
  return { text, used };
}

export async function generatePrompts(postId: string): Promise<PromptResult> {
  const db = createSupabaseAdmin();

  const { data: post, error: postErr } = await db
    .from('competitor_post')
    .select('id, caption, permalink, part2_generated')
    .eq('id', postId)
    .maybeSingle();
  if (postErr) throw new PromptError(postErr.message, 500);
  if (!post) throw new PromptError('Không thấy bài', 404);

  const caption = (post.caption ?? '').trim();
  // Chặn sớm: không có caption thì không có gì để phân tích — đừng gọi API cho tốn tiền.
  if (!caption) throw new PromptError('Bài này không có caption để tạo prompt', 400);

  const { data: tpl, error: tplErr } = await db
    .from('prompt_template')
    .select('body')
    .eq('kind', 'main')
    .maybeSingle();
  if (tplErr) throw new PromptError(tplErr.message, 500);
  if (!tpl?.body?.trim()) {
    throw new PromptError('Chưa có mẫu prompt — vào trang "Mẫu prompt" để thiết lập', 400);
  }

  // Part 2 = comment do chính page đối thủ đăng (đã lọc sẵn lúc cào), fallback bản Gemini sinh
  // từ caption nếu bài không có (xem lib/part2.ts). Chỉ dùng khi mẫu prompt có {{part2}} —
  // mặc định mega-prompt hiện tại không có, nên không tốn token thừa.
  const { data: comments } = await db
    .from('competitor_comment')
    .select('is_page_author, message')
    .eq('competitor_post_id', postId)
    .order('commented_at', { ascending: true });
  const { text: part2 } = getPart2(comments ?? [], post);

  const story = caption.length > MAX_CAPTION_CHARS ? `${caption.slice(0, MAX_CAPTION_CHARS)}\n…(đã cắt)` : caption;

  const filled = fillTemplate(tpl.body, {
    caption: story,
    part2,
    link: post.permalink ?? '',
    title: '',
  });

  // Mega-prompt viết kiểu "When I send you a story…" — chỉ dẫn trước, nội dung sau.
  // Không có placeholder nào thì tự nối khối STORY vào cuối.
  const prompt = filled.used
    ? filled.text
    : `${filled.text.trim()}\n\n==================================================\n\n# STORY\n\n${story}\n`;

  const model = DEFAULT_MODEL;
  let raw: string;
  try {
    raw = await generateText(prompt, { model });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Ghi lại lỗi để lần sau mở trang vẫn thấy vì sao hỏng, rồi ném lên cho route.
    await db
      .from('competitor_post')
      .update({ prompt_error: msg, prompt_model: model, prompt_at: new Date().toISOString() })
      .eq('id', postId);
    throw new PromptError(msg, e instanceof GeminiError ? 502 : 500);
  }

  const sections = splitPromptSections(raw);

  // Tách hỏng KHÔNG phải thất bại: luôn còn prompt_raw để user copy tay.
  const missing: string[] = [];
  if (!sections.image) missing.push('IMAGE PROMPT');
  if (!sections.video) missing.push('VIDEO PROMPT');
  const promptError = missing.length ? `Không tách được mục ${missing.join(' và ')} — xem bản gốc` : null;

  const promptAt = new Date().toISOString();
  const { error: upErr } = await db
    .from('competitor_post')
    .update({
      story_analysis: sections.analysis,
      prompt_image: sections.image,
      prompt_video: sections.video,
      prompt_raw: raw,
      prompt_model: model,
      prompt_at: promptAt,
      prompt_error: promptError,
    })
    .eq('id', postId);
  if (upErr) throw new PromptError(`Sinh được prompt nhưng lưu thất bại: ${upErr.message}`, 500);

  return {
    storyAnalysis: sections.analysis,
    promptImage: sections.image,
    promptVideo: sections.video,
    promptRaw: raw,
    promptError,
    promptModel: model,
    promptAt,
  };
}
