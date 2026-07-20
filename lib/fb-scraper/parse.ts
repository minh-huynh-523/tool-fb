/**
 * Parse các fragment GraphQL của FB feed thành post + comment sạch.
 *
 * FB stream dữ liệu rời: post node (có post_id, message, wwwURL) và comment node (author, body, id)
 * nằm ở các fragment KHÁC nhau, nối với nhau qua post_id. Comment `id` giải base64 ra
 * "comment:<postId>_<commentFbid>" → lấy được postId để gắn comment về đúng post.
 *
 * Giữ MỌI comment, đánh dấu isPageAuthor = (author.id === pageId, fallback author.name === pageName)
 * để UI lọc ra "Part 2" của page — trước đây lọc ngay ở đây nên link do admin thả từ profile cá
 * nhân bị vứt luôn.
 *
 * LƯU Ý về link: feed KHÔNG chứa link "full story" của đối thủ. Đã kiểm chứng bằng cách dump
 * fragment thô 2 lượt — không có comment node nào mang link, cũng không có `ranges`. Link chỉ hiện
 * khi mở PERMALINK từng bài (xem post-links.ts). Phần bóc link ở đây vẫn cần cho link dạng chữ
 * thường nằm sẵn trong caption/comment, nhưng đừng trông đợi nó bắt được link "blue text".
 */
import { contentLinksInText } from '../fb-link';

export interface ParsedComment {
  fbCommentId: string | null;
  authorId: string | null;
  authorName: string | null;
  isPageAuthor: boolean; // comment do CHÍNH page đăng (cột "Part 2") hay của người ngoài
  message: string;
  createdAt: number | null; // unix giây
  linkUrls: string[];
}

export interface ParsedPost {
  fbPostId: string;
  permalink: string | null;
  caption: string;
  linkUrls: string[]; // link bóc từ caption + attachment của chính bài
  mediaType: string | null;
  mediaUrl: string | null;
  createdAt: number | null; // unix giây (best-effort)
  comments: ParsedComment[];
}

// Duyệt sâu mọi object trong cây, gọi visit cho từng node object.
function walk(o: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) {
    for (const it of o) walk(it, visit);
    return;
  }
  visit(o as Record<string, unknown>);
  for (const k in o as Record<string, unknown>) walk((o as Record<string, unknown>)[k], visit);
}

function decodeCommentId(id: string): { postId: string; commentFbid: string } | null {
  try {
    const s = Buffer.from(id, 'base64').toString('utf8'); // "comment:<postId>_<commentFbid>"
    const m = s.match(/^comment:(\d+)_(\d+)/);
    return m ? { postId: m[1], commentFbid: m[2] } : null;
  } catch {
    return null;
  }
}

/**
 * Key mang URL CẤU HÌNH của FB chứ không phải nội dung page.
 *
 * Payload GraphQL có sẵn `block_list_url` / `block_list_url_prefix` — danh sách domain FB tự chặn,
 * và nó chứa đúng mấy shortener mà page đối thủ hay dùng (tinyurl, short.gy…). Không loại thì mọi
 * bài sẽ dính chung một đống link rác giống hệt nhau. (Đã gặp thật khi soi dump raw.)
 */
const CONFIG_URL_KEY = /block_list|blocklist|_prefix$|whitelist|allow_list/i;

/**
 * Gom link trong cả cây con của 1 node, KHÔNG phụ thuộc tên field.
 *
 * FB đổi schema liên tục và link hiển thị dạng "blue text" (chữ hiện ≠ URL) nằm ở nhánh entity/
 * attachment tuỳ biến thể — hard-code đường dẫn sẽ hỏng lần đổi tiếp theo. Duyệt sâu rồi lọc theo
 * host giữ đúng tinh thần parser hiện có: best-effort qua nhiều biến thể schema.
 */
function linksInNode(node: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (o: unknown, key: string) => {
    if (CONFIG_URL_KEY.test(key)) return; // nhánh cấu hình FB — không phải nội dung
    if (typeof o === 'string') {
      if (!o.includes('http')) return;
      for (const u of contentLinksInText(o)) {
        if (!seen.has(u)) {
          seen.add(u);
          out.push(u);
        }
      }
      return;
    }
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const it of o) visit(it, key); // giữ key của mảng để filter cấu hình vẫn ăn
      return;
    }
    for (const k in o as Record<string, unknown>) visit((o as Record<string, unknown>)[k], k);
  };
  visit(node, '');
  return out;
}

// Gộp nhiều nguồn link, bỏ trùng, giữ thứ tự gặp.
function mergeLinks(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of groups) {
    for (const u of g) {
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// Unix giây hợp lệ: sau 2010 và không quá 1 ngày ở tương lai (loại số rác bắt nhầm).
const MIN_TS = 1_262_304_000; // 2010-01-01
function sane(ts: number): number | null {
  const s = ts > 1e12 ? Math.floor(ts / 1000) : ts; // vài field trả milli giây
  return s >= MIN_TS && s < Date.now() / 1000 + 86_400 ? s : null;
}

/**
 * Giờ đăng của post.
 *
 * KHÔNG chỉ đọc node.creation_time: node mang post_id/message thường KHÔNG có creation_time,
 * FB để nó ở nhánh con (comet_sections → metadata → story). Bản cũ chỉ đọc top-level nên hầu hết
 * bài ra null — kết hợp với bộ lọc 6h thành ra loại sạch cả bài mới. Giờ tìm cả trong nhánh con,
 * DFS nên gặp node nông nhất trước (bài chính), tránh vớ phải giờ của bài share lồng bên trong.
 */
function extractCreatedAt(node: Record<string, unknown>): number | null {
  if (typeof node.creation_time === 'number') {
    const top = sane(node.creation_time);
    if (top !== null) return top;
  }
  let found: number | null = null;
  walk(node, (n) => {
    if (found !== null) return;
    for (const key of ['creation_time', 'publish_time', 'created_time']) {
      const v = n[key];
      if (typeof v === 'number') {
        const s = sane(v);
        if (s !== null) {
          found = s;
          return;
        }
      }
    }
  });
  return found;
}

// Lấy ảnh đại diện của post từ attachments (best-effort qua nhiều biến thể schema).
function extractMedia(node: Record<string, unknown>): { type: string | null; url: string | null } {
  let url: string | null = null;
  let type: string | null = null;
  walk(node.attachments, (n) => {
    if (url) return;
    const media = n.media as Record<string, unknown> | undefined;
    if (media && typeof media === 'object') {
      const img = (media.image ?? media.photo_image ?? media.preferred_thumbnail) as Record<string, unknown> | undefined;
      const uri = img && typeof img === 'object' ? str((img as Record<string, unknown>).uri) : null;
      if (uri) {
        url = uri;
        type = str(media.__typename)?.toLowerCase().includes('video') ? 'video' : 'photo';
      }
    }
  });
  return { type, url };
}

export interface ParseResult {
  posts: ParsedPost[];
  pageName: string | null;
  pageId: string | null; // fb_page_id tự bắt từ actors (post do page đăng)
}

/**
 * @param fragments Mảng JSON đã parse từ các response /api/graphql/ (thứ tự bất kỳ).
 * @param pageIdHint fb_page_id để lọc comment của chính page; nếu bỏ trống sẽ tự bắt từ actors.
 */
export function parseFeed(fragments: unknown[], pageIdHint?: string | null): ParseResult {
  const posts = new Map<string, ParsedPost>();
  const commentsByPost = new Map<string, ParsedComment[]>();
  // Giờ đăng nằm ở node KHÁC với node chứa caption, dù cùng post_id: node "message" có
  // caption/attachments nhưng không có creation_time, node feed-unit thì ngược lại. Gom riêng
  // rồi ghép theo post_id — y như cách comment được ghép.
  const timeByPost = new Map<string, number>();
  let pageName: string | null = null;
  let detectedPageId: string | null = null;

  for (const frag of fragments) {
    walk(frag, (node) => {
      // ---- GIỜ ĐĂNG ---- (bất kỳ node nào có post_id + creation_time, kể cả không có message)
      const anyPostId = str(node.post_id);
      if (anyPostId && typeof node.creation_time === 'number') {
        const ts = sane(node.creation_time);
        if (ts !== null && !timeByPost.has(anyPostId)) timeByPost.set(anyPostId, ts);
      }

      // ---- POST node ----
      const postId = str(node.post_id);
      const message = node.message as Record<string, unknown> | undefined;
      if (postId && message && typeof message === 'object' && !posts.has(postId)) {
        const caption = str(message.text) ?? '';
        const permalink = str(node.wwwURL) ?? str(node.url) ?? str(node.permalink_url);
        const { type, url } = extractMedia(node);
        // page đăng post: actors[0] → tên + id (dùng để lọc comment của chính page)
        const actors = node.actors as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(actors) && actors[0]) {
          if (!pageName) pageName = str(actors[0].name);
          if (!detectedPageId) detectedPageId = str(actors[0].id);
        }
        posts.set(postId, {
          fbPostId: postId,
          permalink,
          caption,
          // Caption trước đây KHÔNG hề được bóc link. Lấy cả link plaintext trong text lẫn link
          // ẩn trong message/attachments (link-card "Full story" là dạng phổ biến nhất).
          linkUrls: mergeLinks(contentLinksInText(caption), linksInNode(message), linksInNode(node.attachments)),
          mediaType: type,
          mediaUrl: url,
          createdAt: extractCreatedAt(node),
          comments: [],
        });
      }

      // ---- COMMENT node ----
      // KHÔNG đòi body.text khác rỗng nữa: comment CHỈ có link (không chữ) trước đây bị loại
      // sạch — mà đó đúng là kiểu comment mang link cần lấy.
      const body = node.body as Record<string, unknown> | undefined;
      const author = node.author as Record<string, unknown> | undefined;
      const id = str(node.id);
      if (body && typeof body === 'object' && author && typeof author === 'object' && id) {
        const decoded = decodeCommentId(id);
        if (!decoded) return;
        const text = str(body.text) ?? '';
        const c: ParsedComment = {
          fbCommentId: decoded.commentFbid,
          authorId: str(author.id),
          authorName: str(author.name),
          isPageAuthor: false, // chốt lại ở vòng gắn comment bên dưới (lúc đó mới biết pageId)
          message: text,
          createdAt: typeof node.created_time === 'number' ? node.created_time : null,
          linkUrls: mergeLinks(contentLinksInText(text), linksInNode(body), linksInNode(node.attachments)),
        };
        const arr = commentsByPost.get(decoded.postId) ?? [];
        // tránh trùng comment
        if (!arr.some((x) => x.fbCommentId === c.fbCommentId)) arr.push(c);
        commentsByPost.set(decoded.postId, arr);
      }
    });
  }

  // Gắn comment về post.
  //
  // Trước đây LỌC BỎ luôn comment của người ngoài. Nhưng link "full story" nhiều khi được thả từ
  // profile cá nhân của admin chứ không phải danh tính page — lọc sớm là vứt luôn cả link. Giờ giữ
  // hết, chỉ ĐÁNH DẤU isPageAuthor để cột "Part 2" (vốn chỉ hiện comment của page) vẫn như cũ.
  const pageId = pageIdHint ?? detectedPageId;
  const isPage = (c: ParsedComment) =>
    pageId ? c.authorId === pageId : pageName ? c.authorName === pageName : true;
  for (const [postId, post] of posts) {
    // Node caption thường không mang giờ → lấy từ bảng gom riêng.
    post.createdAt ??= timeByPost.get(postId) ?? null;
    post.comments = (commentsByPost.get(postId) ?? []).map((c) => ({ ...c, isPageAuthor: isPage(c) }));
  }

  return { posts: [...posts.values()], pageName, pageId };
}
