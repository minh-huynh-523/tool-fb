import 'server-only';
import xmlrpc from 'xmlrpc';

function cfg() {
  const url = process.env.WP_XMLRPC_URL;
  const user = process.env.WP_USER;
  const password = process.env.WP_PASSWORD;
  if (!url || !user || !password) {
    throw new Error('Thiếu WP_XMLRPC_URL / WP_USER / WP_PASSWORD trong .env.local');
  }
  return { url, user, password };
}

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
export async function wpUploadFile(input: { name: string; type: string; bits: Buffer }): Promise<WpUploaded> {
  const { url, user, password } = cfg();
  const res = await call<{ id?: number | string; attachment_id?: number | string; url?: string }>(
    url,
    'wp.uploadFile',
    [0, user, password, { name: input.name, type: input.type, bits: input.bits, overwrite: true }],
  );
  const id = res.attachment_id ?? res.id;
  return { id: id != null ? String(id) : '', url: res.url ?? '' };
}

// wp.getPost -> lấy permalink (field `link`). Draft trả dạng ?p=ID — redirect sang pretty permalink sau khi publish.
// Không throw: lỗi trả null để caller fallback tự dựng ?p=.
export async function wpGetPostLink(postId: string): Promise<string | null> {
  try {
    const { url, user, password } = cfg();
    const res = await call<{ link?: string }>(url, 'wp.getPost', [0, user, password, parseInt(postId, 10), ['link']]);
    return res.link ?? null;
  } catch {
    return null;
  }
}

// wp.newPost -> tạo bài (mặc định draft, truyền status: 'publish' để đăng luôn). Trả về post id (string).
export async function wpNewPostDraft(input: {
  title: string;
  contentHtml: string;
  excerpt?: string;
  thumbnailId?: string;
  categories?: string[];
  status?: 'draft' | 'publish';
}): Promise<string> {
  const { url, user, password } = cfg();
  const content: Record<string, unknown> = {
    post_type: 'post',
    post_status: input.status ?? 'draft',
    post_title: input.title,
    post_content: input.contentHtml,
  };
  if (input.excerpt) content.post_excerpt = input.excerpt;
  if (input.thumbnailId) content.post_thumbnail = input.thumbnailId;
  // terms_names: gán category theo TÊN, tự tạo term nếu chưa tồn tại (khác `terms` cần ID).
  if (input.categories?.length) content.terms_names = { category: input.categories };
  const id = await call<string | number>(url, 'wp.newPost', [0, user, password, content]);
  return String(id);
}
