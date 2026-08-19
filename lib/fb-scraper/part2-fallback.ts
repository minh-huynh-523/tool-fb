/**
 * Sinh "Part 2" fallback bằng Gemini cho bài đối thủ KHÔNG có comment nào của page (xem lib/part2.ts
 * cho thứ tự ưu tiên). Chạy sau lượt permalink (scrapePostLinks) — chỉ lúc đó mới biết chắc bài có
 * comment của page hay không (comments_scanned_at đã set). Gọi từ lib/fb-scraper/worker.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createWorkerSupabase } from './supabase';
// CỐ Ý import gemini-core (không phải ../gemini): file kia có 'server-only', ném lỗi ngay khi
// script worker (chạy bằng tsx, Node thuần) import — xem lib/gemini.ts.
import { generateText, GeminiError, DEFAULT_MODEL } from '../gemini-core';

// Trần độ dài Part 2 sinh bằng Gemini. Mẫu prompt (kind='part2', migration 0027) đã yêu cầu
// ≤300 từ, nhưng mẫu SỬA ĐƯỢC trong app (/prompts) và prompt vốn không phải ràng buộc — model
// viết lố là chuyện thường. Chặn lại ở đây để cột Part 2 không bao giờ vượt giới hạn.
const MAX_WORDS = 300;

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Cắt còn tối đa MAX_WORDS từ. Cắt THEO CÂU để không đứt giữa chừng, và luôn GIỮ dòng cuối cùng
 * có chữ — đó là dòng CTA ("Comment YES for full story 👇"), thứ duy nhất kéo được comment; cắt
 * thô từ cuối lên sẽ ăn mất nó.
 */
function capWords(text: string): string {
  if (wordCount(text) <= MAX_WORDS) return text;

  const lines = text.split('\n');
  let ctaIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      ctaIdx = i;
      break;
    }
  }
  const cta = ctaIdx >= 0 ? lines[ctaIdx].trim() : '';
  const body = (ctaIdx >= 0 ? lines.slice(0, ctaIdx).join('\n') : text).trim();
  const budget = MAX_WORDS - wordCount(cta);
  if (budget <= 0) return cta; // CTA tự nó đã quá dài (mẫu bị sửa lạ) — thà giữ mỗi CTA.

  const sentences = body.match(/[^.!?…\n]+[.!?…]*\s*/g) ?? [body];
  let kept = '';
  for (const s of sentences) {
    if (wordCount(kept + s) > budget) break;
    kept += s;
  }
  // Câu đầu tiên đã dài hơn cả budget (caption một mạch không dấu chấm) — đành cắt theo từ.
  if (!kept.trim()) kept = body.split(/\s+/).filter(Boolean).slice(0, budget).join(' ');

  return cta ? `${kept.trim()}\n\n${cta}` : kept.trim();
}

interface CommentRow {
  is_page_author: boolean;
  message: string | null;
}
interface CandidateRow {
  id: string;
  caption: string | null;
  competitor_comment: CommentRow[] | null;
}

export interface Part2FallbackResult {
  scanned: number;
  generated: number;
  failed: number;
  skipped: string | null;
}

export async function generatePart2Fallbacks(db: SupabaseClient = createWorkerSupabase()): Promise<Part2FallbackResult> {
  const { data: tpl, error: tplErr } = await db
    .from('prompt_template')
    .select('body')
    .eq('kind', 'part2')
    .maybeSingle();
  if (tplErr) throw new Error(`Đọc mẫu Part 2 lỗi: ${tplErr.message}`);
  if (!tpl?.body?.trim()) {
    const msg = 'Chưa có mẫu Part 2 — migration 0022 đã chạy chưa?';
    console.warn(`[part2] ${msg}`);
    return { scanned: 0, generated: 0, failed: 0, skipped: msg };
  }
  const template = tpl.body;

  // Chỉ xét bài ĐÃ mở permalink lấy comment (comments_scanned_at set) — trước đó chưa biết chắc
  // bài có comment của page hay không, sinh sớm dễ sinh thừa rồi bị đè bởi comment thật cào sau.
  const { data, error } = await db
    .from('competitor_post')
    .select('id, caption, competitor_comment(is_page_author, message)')
    .not('comments_scanned_at', 'is', null)
    .is('part2_generated_at', null)
    .not('caption', 'is', null);
  if (error) throw new Error(`Đọc bài cần Part 2 fallback lỗi: ${error.message}`);

  const due = ((data ?? []) as CandidateRow[]).filter((p) => {
    if (!(p.caption ?? '').trim()) return false;
    const hasPageComment = (p.competitor_comment ?? []).some((c) => c.is_page_author && (c.message ?? '').trim());
    return !hasPageComment;
  });
  if (!due.length) return { scanned: 0, generated: 0, failed: 0, skipped: null };

  console.log(`[part2] sinh Part 2 fallback cho ${due.length} bài không có comment của page...`);
  let generated = 0;
  let failed = 0;
  for (const p of due) {
    const caption = (p.caption as string).trim();
    const prompt = template.replace(/\{\{\s*caption\s*\}\}/gi, caption);
    const patch: Record<string, unknown> = { part2_generated_at: new Date().toISOString() };
    try {
      const text = (await generateText(prompt, { model: DEFAULT_MODEL })).trim();
      const capped = capWords(text);
      if (capped !== text) {
        console.warn(`  ↳ Part 2 bài ${p.id} dài ${wordCount(text)} từ — cắt còn ≤${MAX_WORDS}`);
      }
      patch.part2_generated = capped;
      patch.part2_generated_error = null;
      generated++;
    } catch (e) {
      const msg = e instanceof GeminiError ? e.message : e instanceof Error ? e.message : String(e);
      patch.part2_generated_error = msg;
      failed++;
    }
    const { error: upErr } = await db.from('competitor_post').update(patch).eq('id', p.id);
    if (upErr) console.error(`  ↳ KHÔNG ghi được Part 2 fallback cho bài ${p.id}: ${upErr.message}`);
  }
  console.log(`[part2] xong: ${generated} sinh được, ${failed} lỗi.`);
  return { scanned: due.length, generated, failed, skipped: null };
}
