// Port của lib/wp-article-gen.ts cho Deno — logic Y HỆT (kể cả firstParagraph() lấy tiêu đề
// nguyên văn từ caption, KHÔNG qua Gemini — xem lib/wp-article-gen.ts bản Next.js để biết lý do).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { generateText, GeminiError, DEFAULT_MODEL } from "./gemini.ts";

export interface ScrapedArticleLike {
  title: string;
  contentHtml: string;
  description: string;
  imageUrl: string | null;
  sourceUrl: string;
  parts: number;
}

export class WpArticleGenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WpArticleGenError";
  }
}

const MAX_CAPTION_CHARS = 20_000;

function fillTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(caption|part2)\s*\}\}/gi, (_m, key: string) => vars[key.toLowerCase()] ?? "");
}

function firstParagraph(caption: string): string {
  const normalized = caption.replace(/\r\n?/g, "\n").trim();
  const m = normalized.match(/^([\s\S]*?)\n\s*\n/);
  const para = m ? m[1] : (normalized.split("\n")[0] ?? normalized);
  return para.trim();
}

export async function generateWpArticleFromFb(db: SupabaseClient, postDbId: string): Promise<ScrapedArticleLike> {
  const { data: post, error: postErr } = await db
    .from("post")
    .select("message, permalink, media_url, image_backup_url")
    .eq("id", postDbId)
    .maybeSingle();
  if (postErr) throw new WpArticleGenError(postErr.message);
  if (!post) throw new WpArticleGenError("Không tìm thấy post");

  const caption = (post.message ?? "").trim();
  if (!caption) throw new WpArticleGenError("Bài này không có caption để tạo bài viết");

  const { data: tpl, error: tplErr } = await db
    .from("prompt_template")
    .select("body")
    .eq("kind", "wp_article")
    .maybeSingle();
  if (tplErr) throw new WpArticleGenError(tplErr.message);
  if (!tpl?.body?.trim()) throw new WpArticleGenError("Chưa có mẫu bài viết — chạy migration 0023 trước");

  const { data: comment } = await db
    .from("scheduled_comment")
    .select("message")
    .eq("post_id", postDbId)
    .order("run_after", { ascending: true })
    .limit(1)
    .maybeSingle();
  const part2 = (comment?.message ?? "").trim();

  const story = caption.length > MAX_CAPTION_CHARS ? `${caption.slice(0, MAX_CAPTION_CHARS)}\n…(đã cắt)` : caption;
  const prompt = fillTemplate(tpl.body, { caption: story, part2 });

  let raw: string;
  try {
    raw = await generateText(prompt, { model: DEFAULT_MODEL });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new WpArticleGenError(e instanceof GeminiError ? msg : `Gemini lỗi: ${msg}`);
  }
  const contentHtml = raw.trim();
  if (!contentHtml) throw new WpArticleGenError("Gemini trả về nội dung rỗng — thử lại");

  return {
    title: firstParagraph(caption),
    contentHtml,
    description: "",
    imageUrl: post.image_backup_url ?? post.media_url ?? null,
    sourceUrl: post.permalink ?? "",
    parts: 1,
  };
}
