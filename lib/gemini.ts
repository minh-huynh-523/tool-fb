import 'server-only';

// Client Gemini tối giản — gọi REST bằng fetch, KHÔNG thêm SDK (đúng kiểu các client
// khác trong repo). Chỉ dùng generateContent, không stream: output được lưu thẳng vào DB
// nên không cần hiển thị dần.

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Ghim model cụ thể thay vì alias -latest: alias đổi ngầm thì output đổi theo mà không ai
// biết; model bị gỡ thì lỗi ra mặt, dễ chẩn đoán hơn. (gemini-2.5-flash đã bị Google ngừng
// cấp cho tài khoản mới — vẫn hiện trong ListModels nhưng gọi là lỗi.)
// Đổi model = đổi env GEMINI_MODEL, không sửa code.
export const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

// Mega-prompt + caption vào, phân tích + 2 prompt dài ra -> mặc định 8k token là vừa;
// dưới mức này Gemini cắt giữa chừng và trả finishReason MAX_TOKENS.
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

// Lỗi có phân loại — UI cần nói được "bị bộ lọc chặn" khác với "mạng lỗi"/"hết quota",
// vì nội dung drama/phản bội chạm bộ lọc là chuyện xảy ra thường xuyên với thể loại này.
export type GeminiErrorKind = 'SAFETY' | 'MAX_TOKENS' | 'TIMEOUT' | 'HTTP' | 'EMPTY' | 'CONFIG';

export class GeminiError extends Error {
  kind: GeminiErrorKind;
  constructor(kind: GeminiErrorKind, message: string) {
    super(message);
    this.name = 'GeminiError';
    this.kind = kind;
  }
}

export async function generateText(prompt: string, opts: { model?: string } = {}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiError('CONFIG', 'Thiếu GEMINI_API_KEY trong biến môi trường');

  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS ?? 90_000);

  let res: Response;
  try {
    res = await fetch(`${API_ROOT}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 1, maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // AbortSignal.timeout() ném TimeoutError; phân biệt với lỗi mạng để user biết nên thử lại hay không.
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new GeminiError('TIMEOUT', `Gemini không phản hồi trong ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new GeminiError('HTTP', `Không gọi được Gemini: ${msg}`);
  }

  const text = await res.text();
  let json: GeminiResponse;
  try {
    json = JSON.parse(text) as GeminiResponse;
  } catch {
    throw new GeminiError('HTTP', `Gemini trả về dữ liệu không phải JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    throw new GeminiError('HTTP', json.error?.message || `Gemini lỗi HTTP ${res.status}`);
  }

  // Bị chặn ngay ở khâu prompt (chưa sinh candidate nào).
  if (json.promptFeedback?.blockReason) {
    throw new GeminiError('SAFETY', `Gemini chặn nội dung đầu vào (${json.promptFeedback.blockReason})`);
  }

  const cand = json.candidates?.[0];
  if (!cand) throw new GeminiError('EMPTY', 'Gemini không trả về kết quả nào');

  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') {
    throw new GeminiError('SAFETY', 'Gemini chặn nội dung vì bộ lọc an toàn — thử sửa caption hoặc đổi model');
  }

  const out = (cand.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();

  if (cand.finishReason === 'MAX_TOKENS') {
    throw new GeminiError('MAX_TOKENS', 'Gemini bị cắt vì output quá dài — tăng maxOutputTokens hoặc rút gọn caption');
  }
  if (!out) throw new GeminiError('EMPTY', `Gemini trả về rỗng (finishReason: ${cand.finishReason ?? 'không rõ'})`);

  return out;
}
