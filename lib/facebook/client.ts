import crypto from 'node:crypto';
import { FB } from './config';

// Lỗi FB chuẩn hoá — mang code/subcode để UI hiển thị rõ.
export class FacebookError extends Error {
  code?: number;
  subcode?: number;
  type?: string;
  fbtraceId?: string;
  status?: number;
  constructor(
    message: string,
    extra: { code?: number; subcode?: number; type?: string; fbtraceId?: string; status?: number } = {},
  ) {
    super(message);
    this.name = 'FacebookError';
    Object.assign(this, extra);
  }
}

function appsecretProof(token: string): string | undefined {
  if (!FB.APP_SECRET) return undefined;
  return crypto.createHmac('sha256', FB.APP_SECRET).update(token).digest('hex');
}

type GraphParams = Record<string, string | number | undefined>;

async function callGraph<T = unknown>(opts: {
  endpoint: string;
  method?: 'GET' | 'POST' | 'DELETE';
  accessToken: string;
  params?: GraphParams;
  body?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}): Promise<T> {
  const { endpoint, method = 'GET', accessToken, params = {}, body, timeoutMs } = opts;
  const url = new URL(FB.BASE + endpoint.replace(/^\//, ''));
  url.searchParams.set('access_token', accessToken);
  const proof = appsecretProof(accessToken);
  if (proof) url.searchParams.set('appsecret_proof', proof);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const init: RequestInit = { method, cache: 'no-store' };
  if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs);
  if (body && method !== 'GET') {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null) form.set(k, String(v));
    }
    init.body = form;
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // Timeout ≠ lỗi mạng: hết giờ chờ nghĩa là KHÔNG BIẾT FB đã nhận hay chưa. Đánh dấu type
    // 'timeout' để tầng trên đừng thử lại (thử lại có thể thành comment thứ 2 trên FB).
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new FacebookError(`Facebook Graph không phản hồi trong ${timeoutMs}ms`, { type: 'timeout' });
    }
    throw new FacebookError(`Không kết nối được Facebook Graph: ${err.message}`);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: Record<string, unknown> } & Record<string, unknown>;
  if (!res.ok || json?.error) {
    const e = (json?.error ?? {}) as Record<string, unknown>;
    throw new FacebookError((e.message as string) || `Facebook API error (${res.status})`, {
      code: e.code as number,
      subcode: e.error_subcode as number,
      type: e.type as string,
      fbtraceId: e.fbtrace_id as string,
      status: res.status,
    });
  }
  return json as T;
}

// Test token: GET /{pageId}?fields=name,picture  -> nếu OK là token còn sống & đúng page.
export async function getPageInfo(
  pageId: string,
  accessToken: string,
): Promise<{ id: string; name: string; pictureUrl: string | null }> {
  const res = await callGraph<{ id: string; name: string; picture?: { data?: { url?: string } } }>({
    endpoint: pageId,
    accessToken,
    params: { fields: 'name,id,picture{url}' },
  });
  return { id: res.id, name: res.name, pictureUrl: res.picture?.data?.url ?? null };
}

export interface FbComment {
  id: string;
  message?: string;
  created_time?: string;
  // ai comment — so sánh from.id với page_id để biết page có tự comment
  from?: { id: string; name?: string; picture?: { data?: { url?: string } } };
}

export interface FbFeedItem {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  status_type?: string;
  is_published?: boolean;
  scheduled_publish_time?: number; // UNIX seconds — chỉ có ở bài lên lịch
  attachments?: {
    data?: Array<{
      media_type?: string;
      type?: string;
      url?: string;
      media?: { image?: { src?: string }; source?: string };
    }>;
  };
  comments?: {
    data?: FbComment[];
    summary?: { total_count?: number };
  };
  // Tổng reaction (mọi loại: like/love/haha/…). Chỉ có ở feed — /scheduled_posts không xin field này.
  reactions?: {
    summary?: { total_count?: number };
  };
}

export interface FbFeedResponse {
  data: FbFeedItem[];
  paging?: { cursors?: { after?: string }; next?: string };
  // false = đã fallback vì Graph không nhận field reactions -> reaction_count sẽ là null.
  reactionsIncluded?: boolean;
}

const FEED_FIELDS_BASE =
  'id,message,created_time,permalink_url,status_type,attachments{media_type,type,url,media}' +
  // Kèm comment inline (1 call) để biết page đã tự comment chưa: from{id} so với page_id.
  ',comments.summary(true).limit(25){from{id},created_time}';

// limit(0) = CHỈ lấy summary, không kéo về danh sách người thả reaction của từng bài.
const FEED_FIELDS_WITH_REACTIONS = FEED_FIELDS_BASE + ',reactions.summary(total_count).limit(0)';

// /{pageId}/posts bị pg_cron gọi MỖI PHÚT (migration 0005). Một field sai tên = Graph trả 400 cho
// CẢ request = chết sạch sync, chứ không phải "thiếu mỗi reaction". Cờ này hạ xuống chuỗi field cũ
// ngay lần đầu Graph than field lạ, và giữ vậy tới khi tiến trình bị recycle (tự lành nếu FB sửa).
let reactionsSupported = true;

// Đọc feed của page: GET /{pageId}/posts
export async function getPageFeed(
  pageId: string,
  accessToken: string,
  opts: { limit?: number; after?: string } = {},
): Promise<FbFeedResponse> {
  const params: GraphParams = {
    fields: reactionsSupported ? FEED_FIELDS_WITH_REACTIONS : FEED_FIELDS_BASE,
    limit: opts.limit ?? 25,
  };
  if (opts.after) params.after = opts.after;

  try {
    const res = await callGraph<FbFeedResponse>({ endpoint: `${pageId}/posts`, accessToken, params });
    return { ...res, reactionsIncluded: reactionsSupported };
  } catch (e) {
    // Code 100 còn dùng cho cursor/param sai — CHỈ nuốt khi đúng là lỗi tên field, không thì
    // fallback sẽ che mất lỗi thật và ta mất luôn tín hiệu để sửa.
    const badField =
      reactionsSupported &&
      e instanceof FacebookError &&
      e.code === 100 &&
      /nonexisting field|reactions/i.test(e.message);
    if (!badField) throw e;

    reactionsSupported = false;
    const res = await callGraph<FbFeedResponse>({
      endpoint: `${pageId}/posts`,
      accessToken,
      params: { ...params, fields: FEED_FIELDS_BASE },
    });
    return { ...res, reactionsIncluded: false };
  }
}

// Đọc comment top-level của 1 bài (dùng ở trang chi tiết để hiển thị comment thật).
// Tham khảo hercules: GET /{postId}/comments fields=...from{id,name,picture} filter=toplevel.
export async function getPostComments(
  fbPostId: string,
  accessToken: string,
  opts: { limit?: number; after?: string } = {},
): Promise<{ data: FbComment[]; summary?: { total_count?: number } }> {
  const params: GraphParams = {
    fields: "id,message,created_time,from{id,name,picture}",
    filter: "toplevel",
    summary: "true",
    limit: opts.limit ?? 50,
  };
  if (opts.after) params.after = opts.after;
  const res = await callGraph<{ data?: FbComment[]; summary?: { total_count?: number } }>({
    endpoint: `${fbPostId}/comments`,
    accessToken,
    params,
  });
  return { data: res.data ?? [], summary: res.summary };
}

export interface FbVideoItem {
  id: string;
  description?: string;
  created_time?: string; // thời điểm upload/lên lịch (KHÔNG phải giờ sẽ đăng)
  updated_time?: string;
  published?: boolean; // false = video đã upload nhưng CHƯA có post live (lên lịch/draft Business Suite)
  scheduled_publish_time?: number; // UNIX seconds — CHỈ có khi lên lịch qua API (Business Suite không expose)
  permalink_url?: string; // dạng tương đối "/reel/{id}/"
  picture?: string; // thumbnail
  status?: { publishing_phase?: { publish_status?: string } };
}

// Đọc video/reel của page: GET /{pageId}/videos
// QUAN TRỌNG (đã verify trên page thật): reel lên lịch bằng Business Suite KHÔNG hiện ở
// /scheduled_posts nhưng CÓ hiện ở đây với published=false (0/6 bài published=false nằm
// trong feed; 32/32 bài published=true đều có post live). status.publishing_phase chỉ nói
// pipeline xử lý video xong — KHÔNG phải post đã public; tin `published`.
export async function getPageVideos(
  pageId: string,
  accessToken: string,
  opts: { limit?: number; after?: string } = {},
): Promise<{ data: FbVideoItem[]; paging?: { cursors?: { after?: string }; next?: string } }> {
  const params: GraphParams = {
    fields:
      'id,description,created_time,updated_time,published,scheduled_publish_time,permalink_url,picture,status{publishing_phase}',
    limit: opts.limit ?? 50,
  };
  if (opts.after) params.after = opts.after;
  return callGraph<{ data: FbVideoItem[]; paging?: { cursors?: { after?: string }; next?: string } }>({
    endpoint: `${pageId}/videos`,
    accessToken,
    params,
  });
}

// Đọc bài ĐANG LÊN LỊCH (chưa publish): GET /{pageId}/scheduled_posts
// Cần page token có quyền pages_read_engagement / pages_read_user_content.
// Trả PagePost với is_published=false + scheduled_publish_time (UNIX seconds).
export async function getScheduledPosts(
  pageId: string,
  accessToken: string,
  opts: { limit?: number; after?: string } = {},
): Promise<FbFeedResponse> {
  const params: GraphParams = {
    fields:
      'id,message,created_time,scheduled_publish_time,is_published,permalink_url,status_type,attachments{media_type,type,url,media}',
    limit: opts.limit ?? 50,
  };
  if (opts.after) params.after = opts.after;
  return callGraph<FbFeedResponse>({ endpoint: `${pageId}/scheduled_posts`, accessToken, params });
}

// Trích media_type + ảnh/thumbnail từ attachments để hiển thị.
export function extractMedia(item: FbFeedItem): { mediaType: string | null; mediaUrl: string | null } {
  const att = item.attachments?.data?.[0];
  const mediaType = att?.media_type || att?.type || item.status_type || null;
  const mediaUrl = att?.media?.image?.src || att?.media?.source || null;
  return { mediaType, mediaUrl };
}

// Trần thời gian cho CHÍNH lệnh đăng comment. `fetch` không có timeout mặc định, mà worker coi row
// PROCESSING quá staleMs (mặc định 120s) là treo và cho lượt cron sau gửi LẠI — call treo lâu hơn
// mốc đó là bắn 2 comment thật lên FB. Trần này phải luôn nhỏ hơn staleMs.
const COMMENT_TIMEOUT_MS = 30_000;

// Đăng comment: POST /{fbPostId}/comments  body {message, attachment_url}
export async function createPostComment(
  fbPostId: string,
  accessToken: string,
  input: { message?: string; attachmentUrl?: string },
): Promise<{ id: string }> {
  const body: Record<string, string> = {};
  if (input.message && input.message.trim().length > 0) body.message = input.message;
  if (input.attachmentUrl) body.attachment_url = input.attachmentUrl;
  return callGraph<{ id: string }>({
    endpoint: `${fbPostId}/comments`,
    method: 'POST',
    accessToken,
    body,
    timeoutMs: COMMENT_TIMEOUT_MS,
  });
}
