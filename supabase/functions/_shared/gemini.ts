// Port của lib/gemini-core.ts cho Deno (Supabase Edge Functions) — logic Y HỆT, chỉ đổi
// process.env -> Deno.env.get. KHÔNG dùng SDK, chỉ fetch() thuần (giống bản Next.js).

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

export const DEFAULT_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash";

const MAX_OUTPUT_TOKENS = 8192;

interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export type GeminiErrorKind = "SAFETY" | "MAX_TOKENS" | "TIMEOUT" | "HTTP" | "EMPTY" | "CONFIG";

export class GeminiError extends Error {
  kind: GeminiErrorKind;
  constructor(kind: GeminiErrorKind, message: string) {
    super(message);
    this.name = "GeminiError";
    this.kind = kind;
  }
}

export async function generateText(prompt: string, opts: { model?: string } = {}): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new GeminiError("CONFIG", "Thiếu GEMINI_API_KEY trong secrets");

  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = Number(Deno.env.get("GEMINI_TIMEOUT_MS") ?? 90_000);

  let res: Response;
  try {
    res = await fetch(`${API_ROOT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 1, maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new GeminiError("TIMEOUT", `Gemini không phản hồi trong ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new GeminiError("HTTP", `Không gọi được Gemini: ${msg}`);
  }

  const text = await res.text();
  let json: GeminiResponse;
  try {
    json = JSON.parse(text) as GeminiResponse;
  } catch {
    throw new GeminiError("HTTP", `Gemini trả về dữ liệu không phải JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    throw new GeminiError("HTTP", json.error?.message || `Gemini lỗi HTTP ${res.status}`);
  }
  if (json.promptFeedback?.blockReason) {
    throw new GeminiError("SAFETY", `Gemini chặn nội dung đầu vào (${json.promptFeedback.blockReason})`);
  }

  const cand = json.candidates?.[0];
  if (!cand) throw new GeminiError("EMPTY", "Gemini không trả về kết quả nào");
  if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") {
    throw new GeminiError("SAFETY", "Gemini chặn nội dung vì bộ lọc an toàn — thử sửa caption hoặc đổi model");
  }

  const out = (cand.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();

  if (cand.finishReason === "MAX_TOKENS") {
    throw new GeminiError("MAX_TOKENS", "Gemini bị cắt vì output quá dài — tăng maxOutputTokens hoặc rút gọn caption");
  }
  if (!out) throw new GeminiError("EMPTY", `Gemini trả về rỗng (finishReason: ${cand.finishReason ?? "không rõ"})`);

  return out;
}
