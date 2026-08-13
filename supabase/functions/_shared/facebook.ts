// Port của lib/facebook/config.ts + lib/facebook/client.ts cho Deno — TOÀN BỘ client Graph (sync
// cần getPageFeed/getPageVideos/getScheduledPosts/getPageInfo, không chỉ createPostComment như
// bản port trước). Logic Y HỆT bản Node, chỉ đổi process.env -> Deno.env.get.
import { createHmac } from "node:crypto";

const FB = {
  BASE: `https://graph.facebook.com/${Deno.env.get("FACEBOOK_GRAPH_VERSION") ?? "v25.0"}/`,
  APP_SECRET: Deno.env.get("FACEBOOK_APP_SECRET") || "",
};

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
    this.name = "FacebookError";
    Object.assign(this, extra);
  }
}

function appsecretProof(token: string): string | undefined {
  if (!FB.APP_SECRET) return undefined;
  return createHmac("sha256", FB.APP_SECRET).update(token).digest("hex");
}

type GraphParams = Record<string, string | number | undefined>;

async function callGraph<T = unknown>(opts: {
  endpoint: string;
  method?: "GET" | "POST" | "DELETE";
  accessToken: string;
  params?: GraphParams;
  body?: Record<string, string | number | undefined>;
  timeoutMs?: number;
}): Promise<T> {
  const { endpoint, method = "GET", accessToken, params = {}, body, timeoutMs } = opts;
  const url = new URL(FB.BASE + endpoint.replace(/^\//, ""));
  url.searchParams.set("access_token", accessToken);
  const proof = appsecretProof(accessToken);
  if (proof) url.searchParams.set("appsecret_proof", proof);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const init: RequestInit = { method };
  if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs);
  if (body && method !== "GET") {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null) form.set(k, String(v));
    }
    init.body = form;
    init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // Timeout ≠ lỗi mạng: hết giờ chờ nghĩa là KHÔNG BIẾT FB đã nhận hay chưa. Đánh dấu type
    // 'timeout' để tầng trên đừng thử lại (thử lại có thể thành comment thứ 2 trên FB).
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new FacebookError(`Facebook Graph không phản hồi trong ${timeoutMs}ms`, { type: "timeout" });
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

// Test token: GET /{pageId}?fields=name,picture -> nếu OK là token còn sống & đúng page.
export async function getPageInfo(
  pageId: string,
  accessToken: string,
): Promise<{ id: string; name: string; pictureUrl: string | null }> {
  const res = await callGraph<{ id: string; name: string; picture?: { data?: { url?: string } } }>({
    endpoint: pageId,
    accessToken,
    params: { fields: "name,id,picture{url}" },
  });
  return { id: res.id, name: res.name, pictureUrl: res.picture?.data?.url ?? null };
}

export interface FbComment {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id: string; name?: string; picture?: { data?: { url?: string } } };
}

export interface FbFeedItem {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  status_type?: string;
  is_published?: boolean;
  scheduled_publish_time?: number;
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
  reactions?: {
    summary?: { total_count?: number };
  };
}

export interface FbFeedResponse {
  data: FbFeedItem[];
  paging?: { cursors?: { after?: string }; next?: string };
  reactionsIncluded?: boolean;
}

const FEED_FIELDS_BASE =
  "id,message,created_time,permalink_url,status_type,attachments{media_type,type,url,media}" +
  ",comments.summary(true).limit(25){from{id},created_time}";

const FEED_FIELDS_WITH_REACTIONS = FEED_FIELDS_BASE + ",reactions.summary(total_count).limit(0)";

// Cùng cờ tự-hạ-cấp với bản Node (lib/facebook/client.ts) — 1 field sai tên là Graph trả 400 cho
// CẢ request. Instance riêng mỗi Edge Function invocation (không persist qua các lượt gọi khác
// nhau như biến module-level ở Node) — tự thử lại reactions ở lượt kế tiếp, tự lành nếu FB sửa.
let reactionsSupported = true;

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
  created_time?: string;
  updated_time?: string;
  published?: boolean;
  scheduled_publish_time?: number;
  permalink_url?: string;
  picture?: string;
  status?: { publishing_phase?: { publish_status?: string } };
}

export async function getPageVideos(
  pageId: string,
  accessToken: string,
  opts: { limit?: number; after?: string } = {},
): Promise<{ data: FbVideoItem[]; paging?: { cursors?: { after?: string }; next?: string } }> {
  const params: GraphParams = {
    fields:
      "id,description,created_time,updated_time,published,scheduled_publish_time,permalink_url,picture,status{publishing_phase}",
    limit: opts.limit ?? 50,
  };
  if (opts.after) params.after = opts.after;
  return callGraph<{ data: FbVideoItem[]; paging?: { cursors?: { after?: string }; next?: string } }>({
    endpoint: `${pageId}/videos`,
    accessToken,
    params,
  });
}

export async function getScheduledPosts(
  pageId: string,
  accessToken: string,
  opts: { limit?: number; after?: string } = {},
): Promise<FbFeedResponse> {
  const params: GraphParams = {
    fields:
      "id,message,created_time,scheduled_publish_time,is_published,permalink_url,status_type,attachments{media_type,type,url,media}",
    limit: opts.limit ?? 50,
  };
  if (opts.after) params.after = opts.after;
  return callGraph<FbFeedResponse>({ endpoint: `${pageId}/scheduled_posts`, accessToken, params });
}

export function extractMedia(item: FbFeedItem): { mediaType: string | null; mediaUrl: string | null } {
  const att = item.attachments?.data?.[0];
  const mediaType = att?.media_type || att?.type || item.status_type || null;
  const mediaUrl = att?.media?.image?.src || att?.media?.source || null;
  return { mediaType, mediaUrl };
}

// Trần thời gian cho CHÍNH lệnh đăng comment — phải luôn nhỏ hơn STALE_MS (comments.ts) để tránh
// bắn 2 comment thật khi worker coi 1 lượt gọi treo là chết và cho lượt sau gửi lại.
const COMMENT_TIMEOUT_MS = 20_000;

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
    method: "POST",
    accessToken,
    body,
    timeoutMs: COMMENT_TIMEOUT_MS,
  });
}
