import 'server-only';
import xmlrpc from 'xmlrpc';
import type { WpSite } from './site';

// Site đích (URL + creds) do caller resolve theo page — xem lib/wordpress/site.ts.

// Gọi 1 method XML-RPC, promisify callback của lib. Lỗi fault -> ném kèm faultString.
function call<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const client = url.startsWith('https') ? xmlrpc.createSecureClient({ url }) : xmlrpc.createClient({ url });
  return new Promise<T>((resolve, reject) => {
    client.methodCall(method, params, (err: unknown, value: unknown) => {
      if (err) {
        const e = err as { faultString?: string; message?: string };
        reject(new Error(e.faultString ?? e.message ?? 'Lỗi XML-RPC'));
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

// wp.uploadFile -> upload media, trả attachment {id, url}. bits: Buffer (lib serialize base64).
export async function wpUploadFile(
  site: WpSite,
  input: { name: string; type: string; bits: Buffer },
): Promise<WpUploaded> {
  const { xmlrpcUrl: url, user, password } = site;
  const res = await call<{ id?: number | string; attachment_id?: number | string; url?: string }>(
    url,
    'wp.uploadFile',
    [0, user, password, { name: input.name, type: input.type, bits: input.bits, overwrite: true }],
  );
  const id = res.attachment_id ?? res.id;
  return { id: id != null ? String(id) : '', url: res.url ?? '' };
}

// Slug từ title (xấp xỉ sanitize_title của WP): bỏ dấu, bỏ nháy, ký tự khác chữ/số -> '-'.
export function slugifyTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/['’"“”]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

// wp.getPost -> { link, slug, status, title }. Bài publish: link là pretty permalink; draft: link dạng ?p=ID
// nhưng slug (post_name) có sẵn do mình set lúc tạo -> caller tự dựng pretty link.
// Không throw: lỗi trả null hết để caller fallback.
export async function wpGetPostInfo(
  site: WpSite,
  postId: string,
): Promise<{
  link: string | null;
  slug: string | null;
  status: string | null;
  title: string | null;
}> {
  try {
    const { xmlrpcUrl: url, user, password } = site;
    const res = await call<{ link?: string; post_name?: string; post_status?: string; post_title?: string }>(
      url,
      'wp.getPost',
      [0, user, password, parseInt(postId, 10), ['link', 'post_name', 'post_status', 'post_title']],
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

// wp.editPost -> sửa bài đã tồn tại (title/content/ảnh đại diện/status/category). KHÔNG set post_name
// (giữ nguyên slug hiện có) để không phá permalink đã chia sẻ/lên lịch comment. thumbnailId "0" = gỡ ảnh
// đại diện; undefined = giữ nguyên ảnh cũ. Trả về true/false theo WP.
export async function wpEditPost(
  site: WpSite,
  postId: string,
  input: {
    title?: string;
    contentHtml?: string;
    excerpt?: string;
    thumbnailId?: string;
    categories?: string[];
    status?: 'draft' | 'publish';
  },
): Promise<boolean> {
  const { xmlrpcUrl: url, user, password } = site;
  const content: Record<string, unknown> = {};
  if (input.title !== undefined) content.post_title = input.title;
  if (input.contentHtml !== undefined) content.post_content = input.contentHtml;
  if (input.excerpt !== undefined) content.post_excerpt = input.excerpt;
  if (input.thumbnailId !== undefined) content.post_thumbnail = Number(input.thumbnailId);
  if (input.status !== undefined) content.post_status = input.status;
  if (input.categories?.length) content.terms_names = { category: input.categories };
  const ok = await call<boolean>(url, 'wp.editPost', [0, user, password, parseInt(postId, 10), content]);
  return !!ok;
}

// wp.newPost -> tạo bài (mặc định draft, truyền status: 'publish' để đăng luôn). Trả về post id (string).
export async function wpNewPostDraft(
  site: WpSite,
  input: {
    title: string;
    contentHtml: string;
    excerpt?: string;
    thumbnailId?: string;
    categories?: string[];
    status?: 'draft' | 'publish';
  },
): Promise<string> {
  const { xmlrpcUrl: url, user, password } = site;
  const content: Record<string, unknown> = {
    post_type: 'post',
    post_status: input.status ?? 'draft',
    post_title: input.title,
    post_content: input.contentHtml,
  };
  if (input.excerpt) content.post_excerpt = input.excerpt;
  if (input.thumbnailId) content.post_thumbnail = input.thumbnailId;
  // Set slug ngay lúc tạo (WP không sinh post_name cho draft) -> pretty permalink biết trước được.
  const slug = slugifyTitle(input.title);
  if (slug) content.post_name = slug;
  // terms_names: gán category theo TÊN, tự tạo term nếu chưa tồn tại (khác `terms` cần ID).
  if (input.categories?.length) content.terms_names = { category: input.categories };
  const id = await call<string | number>(url, 'wp.newPost', [0, user, password, content]);
  return String(id);
}
