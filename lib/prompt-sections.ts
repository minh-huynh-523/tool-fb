// Tách output Gemini thành 3 mục theo "# OUTPUT FORMAT" của mega-prompt:
//   ### STORY ANALYSIS / ### IMAGE PROMPT / ### VIDEO PROMPT
// Thuần, không I/O — tách riêng khỏi competitor-prompt.ts để test được bằng tsx.
//
// Chịu lỗi là yêu cầu chính: LLM hay lệch format (dùng ## thay ###, in đậm thay heading,
// bỏ quên một mục, hoặc nhại lại phần hướng dẫn trước khi trả kết quả thật).

export interface PromptSections {
  analysis: string | null;
  image: string | null;
  video: string | null;
}

type SectionKind = 'analysis' | 'image' | 'video' | 'other';

const KNOWN_TITLES = ['STORY ANALYSIS', 'IMAGE PROMPT', 'PROMPT IMAGE', 'VIDEO PROMPT', 'PROMPT VIDEO'];

// Chuẩn hoá 1 dòng tiêu đề: bỏ #, **, dấu hai chấm, gộp khoảng trắng, viết hoa.
function normalizeTitle(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/[:：]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function classify(title: string): SectionKind {
  if (title.includes('STORY ANALYSIS') || title === 'ANALYSIS') return 'analysis';
  if (title.includes('IMAGE PROMPT') || title.includes('PROMPT IMAGE')) return 'image';
  if (title.includes('VIDEO PROMPT') || title.includes('PROMPT VIDEO')) return 'video';
  return 'other';
}

// Chỉ chữ HOA (không có chữ thường nào) -> mới là tiêu đề mục cấp trên.
function isAllCaps(line: string): boolean {
  const t = line.replace(/^\s*#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/[:：]\s*$/, '').trim();
  return /[A-Z]/.test(t) && !/[a-z]/.test(t);
}

// Ranh giới mục = (heading markdown #… | in đậm cả dòng | dòng trần)
//                 VÀ (viết HOA toàn bộ | đúng một tiêu đề đã biết).
// Vế thứ hai là điểm mấu chốt: model rất hay in đậm/heading các mục con của VIDEO PROMPT
// ("**Scene Description:**", "### Camera Movement:"). Chúng viết thường nên KHÔNG bị coi là
// ranh giới -> prompt video giữ nguyên cả khối thay vì bị cắt cụt ở mục con đầu tiên.
function isBoundary(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  const looksLikeHeading = /^#{1,6}\s+\S/.test(t) || /^\*\*[^*]+\*\*:?$/.test(t);
  const known = KNOWN_TITLES.includes(normalizeTitle(t));
  if (known) return true;
  return looksLikeHeading && isAllCaps(t);
}

// Bỏ placeholder mà model đôi khi chép nguyên từ phần "# OUTPUT FORMAT"
// (vd "[Complete image prompt]") — đó không phải kết quả thật.
function isPlaceholder(body: string): boolean {
  return /^\[[^\]\n]*\]$/.test(body.trim());
}

function cleanBody(lines: string[]): string | null {
  let body = lines.join('\n').trim();
  // Bỏ đường kẻ ==== / ---- ở đầu và cuối (mega-prompt dùng chúng làm vách ngăn).
  body = body.replace(/^(?:[=-]{3,}\s*\n)+/, '').replace(/(?:\n\s*[=-]{3,})+$/, '').trim();
  if (!body || isPlaceholder(body)) return null;
  return body;
}

export function splitPromptSections(raw: string): PromptSections {
  const empty: PromptSections = { analysis: null, image: null, video: null };
  if (!raw?.trim()) return empty;

  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  const boundaries: { line: number; kind: SectionKind }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBoundary(lines[i])) boundaries.push({ line: i, kind: classify(normalizeTitle(lines[i])) });
  }
  if (boundaries.length === 0) return empty;

  // Lấy lần xuất hiện CUỐI của mỗi mục: nếu model nhại lại phần hướng dẫn trước rồi mới
  // trả kết quả thật, kết quả thật luôn nằm sau.
  const pick = (kind: SectionKind): string | null => {
    for (let b = boundaries.length - 1; b >= 0; b--) {
      if (boundaries[b].kind !== kind) continue;
      const start = boundaries[b].line + 1;
      const end = b + 1 < boundaries.length ? boundaries[b + 1].line : lines.length;
      const body = cleanBody(lines.slice(start, end));
      if (body) return body;
      // Mục này rỗng/placeholder -> thử lần xuất hiện trước đó.
    }
    return null;
  };

  return { analysis: pick('analysis'), image: pick('image'), video: pick('video') };
}
