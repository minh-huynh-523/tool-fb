// Port của lib/facebook/config.ts + phần createPostComment của lib/facebook/client.ts cho Deno.
// Chỉ port đúng phần Edge Function cần (đăng comment) — không port toàn bộ client FB Graph.
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

export async function createPostComment(
  fbPostId: string,
  accessToken: string,
  input: { message?: string; attachmentUrl?: string },
): Promise<{ id: string }> {
  const url = new URL(FB.BASE + `${fbPostId}/comments`);
  url.searchParams.set("access_token", accessToken);
  const proof = appsecretProof(accessToken);
  if (proof) url.searchParams.set("appsecret_proof", proof);

  const form = new URLSearchParams();
  if (input.message && input.message.trim().length > 0) form.set("message", input.message);
  if (input.attachmentUrl) form.set("attachment_url", input.attachmentUrl);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new FacebookError("Facebook Graph không phản hồi kịp lúc đăng comment", { type: "timeout" });
    }
    throw new FacebookError(`Không kết nối được Facebook Graph: ${err.message}`);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: Record<string, unknown>; id?: string };
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
  return { id: json.id! };
}
