// Port của lib/wordpress/client.ts + lib/wordpress/site.ts cho Deno.
// RỦI RO DUY NHẤT của cả việc chuyển sang Edge Function: package `xmlrpc` vốn viết cho Node
// (dùng node:http/https qua Deno npm-compat). Nếu deploy xong mà lỗi ở đúng chỗ gọi WordPress,
// khả năng cao là do đây — fallback là viết tay request XML-RPC bằng fetch() (không khó, chỉ 4
// method: wp.uploadFile / wp.newPost / wp.editPost / wp.getPost).
import xmlrpc from "npm:xmlrpc@1.3.2";
import { Buffer } from "npm:buffer";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { decryptToken } from "./crypto.ts";

export interface WpSite {
  xmlrpcUrl: string;
  baseUrl: string;
  category: string;
  user: string;
  password: string;
}

function call<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const client = url.startsWith("https") ? xmlrpc.createSecureClient({ url }) : xmlrpc.createClient({ url });
  return new Promise<T>((resolve, reject) => {
    client.methodCall(method, params, (err: unknown, value: unknown) => {
      if (err) {
        const e = err as { faultString?: string; message?: string };
        reject(new Error(e.faultString ?? e.message ?? "Lỗi XML-RPC"));
      } else {
        resolve(value as T);
      }
    });
  });
}

export interface WpUploaded {
  id: string;
  url: string;
}

export async function wpUploadFile(
  site: WpSite,
  input: { name: string; type: string; bits: Uint8Array },
): Promise<WpUploaded> {
  const { xmlrpcUrl: url, user, password } = site;
  try {
    console.log(`[wpUploadFile] start upload name=${input.name} type=${input.type} size=${input.bits?.length ?? 0}`);
  } catch {}

  // xmlrpc library expects a Node Buffer (base64-able). Convert Uint8Array -> Buffer for Deno npm-compat.
  const bitsBuf = Buffer.from(input.bits ?? new Uint8Array());

  const res = await call<{ id?: number | string; attachment_id?: number | string; url?: string }>(
    url,
    "wp.uploadFile",
    [0, user, password, { name: input.name, type: input.type, bits: bitsBuf, overwrite: true }],
  );
  const id = res.attachment_id ?? res.id;
  try {
    console.log(`[wpUploadFile] result id=${id ?? "<none>"} url=${res.url ?? "<none>"}`);
  } catch {}
  return { id: id != null ? String(id) : "", url: res.url ?? "" };
}

export function slugifyTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/['’"“”]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

export async function wpGetPostInfo(
  site: WpSite,
  postId: string,
): Promise<{ link: string | null; slug: string | null; status: string | null; title: string | null }> {
  try {
    const { xmlrpcUrl: url, user, password } = site;
    const res = await call<{ link?: string; post_name?: string; post_status?: string; post_title?: string }>(
      url,
      "wp.getPost",
      [0, user, password, parseInt(postId, 10), ["link", "post_name", "post_status", "post_title"]],
    );
    return {
      link: res.link ?? null,
      slug: res.post_name || null,
      status: res.post_status ?? null,
      title: res.post_title ?? null,
    };
  } catch {
    return { link: null, slug: null, status: null, title: null };
  }
}

export async function wpNewPostDraft(
  site: WpSite,
  input: {
    title: string;
    contentHtml: string;
    excerpt?: string;
    thumbnailId?: string;
    categories?: string[];
    status?: "draft" | "publish";
  },
): Promise<string> {
  const { xmlrpcUrl: url, user, password } = site;
  const content: Record<string, unknown> = {
    post_type: "post",
    post_status: input.status ?? "draft",
    post_title: input.title,
    post_content: input.contentHtml,
  };
  if (input.excerpt) content.post_excerpt = input.excerpt;
  if (input.thumbnailId) content.post_thumbnail = input.thumbnailId;
  const slug = slugifyTitle(input.title);
  if (slug) content.post_name = slug;
  if (input.categories?.length) content.terms_names = { category: input.categories };
  const id = await call<string | number>(url, "wp.newPost", [0, user, password, content]);
  return String(id);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// Resolve site WP cho 1 post: post.page_id -> facebook_page.wp_*; cột trống thì fallback về secret.
export async function getWpSiteForPost(db: SupabaseClient, postDbId: string): Promise<WpSite> {
  const { data: post, error: postErr } = await db.from("post").select("page_id").eq("id", postDbId).maybeSingle();
  if (postErr) throw new Error(postErr.message);
  if (!post) throw new Error("Không tìm thấy post");

  const { data: page, error: pageErr } = await db
    .from("facebook_page")
    .select("name, wp_xmlrpc_url, wp_base_url, wp_category, wp_user, wp_password_enc")
    .eq("page_id", post.page_id)
    .maybeSingle();
  if (pageErr) throw new Error(pageErr.message);

  const label = page?.name ? `page "${page.name}"` : `page ${post.page_id}`;
  const xmlrpcUrl = (page?.wp_xmlrpc_url || Deno.env.get("WP_XMLRPC_URL") || "").trim();
  const baseUrl = trimSlash((page?.wp_base_url || Deno.env.get("WP_BASE_URL") || "").trim());
  const category = (page?.wp_category || Deno.env.get("WP_CATEGORY") || "Story").trim();
  const { user, password } = resolveCredentials(page, label);

  if (!xmlrpcUrl) {
    throw new Error(`Chưa cấu hình WordPress cho ${label}: thêm XML-RPC URL ở trang Pages (hoặc đặt secret WP_XMLRPC_URL)`);
  }
  if (!user || !password) {
    throw new Error("Thiếu secret WP_USER / WP_PASSWORD");
  }
  return { xmlrpcUrl, baseUrl, category, user, password };
}

// Port của resolveCredentials trong lib/wordpress/site.ts — giữ CÙNG luật để cron (Edge) và bấm
// tay (Next) không bao giờ đăng bằng 2 credential khác nhau cho cùng 1 page.
function resolveCredentials(
  page: { wp_user?: string | null; wp_password_enc?: string | null } | null,
  label: string,
): { user: string; password: string } {
  const pageUser = page?.wp_user?.trim() || "";
  const pagePassword = page?.wp_password_enc?.trim() || "";

  if (pageUser && !pagePassword) {
    throw new Error(`${label} có username WordPress riêng nhưng chưa có mật khẩu — nhập lại mật khẩu ở trang Pages`);
  }
  if (pagePassword && !pageUser) {
    throw new Error(`${label} có mật khẩu WordPress riêng nhưng chưa có username — nhập lại ở trang Pages`);
  }
  if (pageUser && pagePassword) {
    return { user: pageUser, password: decryptToken(pagePassword) };
  }
  return { user: Deno.env.get("WP_USER") ?? "", password: Deno.env.get("WP_PASSWORD") ?? "" };
}
