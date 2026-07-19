/**
 * Parse các fragment GraphQL của FB feed thành post + comment sạch.
 *
 * FB stream dữ liệu rời: post node (có post_id, message, wwwURL) và comment node (author, body, id)
 * nằm ở các fragment KHÁC nhau, nối với nhau qua post_id. Comment `id` giải base64 ra
 * "comment:<postId>_<commentFbid>" → lấy được postId để gắn comment về đúng post.
 *
 * Chỉ giữ comment của CHÍNH page: lọc author.id === pageId (fallback author.name === pageName).
 */

export interface ParsedComment {
  fbCommentId: string | null;
  authorId: string | null;
  authorName: string | null;
  message: string;
  createdAt: number | null; // unix giây
  linkUrl: string | null;
}

export interface ParsedPost {
  fbPostId: string;
  permalink: string | null;
  caption: string;
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

// URL đầu tiên trong text (first-comment kiểu "Full story: https://…").
function extractLink(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
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
  let pageName: string | null = null;
  let detectedPageId: string | null = null;

  for (const frag of fragments) {
    walk(frag, (node) => {
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
          mediaType: type,
          mediaUrl: url,
          createdAt: typeof node.creation_time === 'number' ? node.creation_time : null,
          comments: [],
        });
      }

      // ---- COMMENT node ----
      const body = node.body as Record<string, unknown> | undefined;
      const author = node.author as Record<string, unknown> | undefined;
      const id = str(node.id);
      if (body && typeof body === 'object' && str(body.text) && author && typeof author === 'object' && id) {
        const decoded = decodeCommentId(id);
        if (!decoded) return;
        const text = str(body.text) ?? '';
        const c: ParsedComment = {
          fbCommentId: decoded.commentFbid,
          authorId: str(author.id),
          authorName: str(author.name),
          message: text,
          createdAt: typeof node.created_time === 'number' ? node.created_time : null,
          linkUrl: extractLink(text),
        };
        const arr = commentsByPost.get(decoded.postId) ?? [];
        // tránh trùng comment
        if (!arr.some((x) => x.fbCommentId === c.fbCommentId)) arr.push(c);
        commentsByPost.set(decoded.postId, arr);
      }
    });
  }

  // Gắn comment CỦA CHÍNH PAGE về post.
  const pageId = pageIdHint ?? detectedPageId;
  for (const [postId, post] of posts) {
    const all = commentsByPost.get(postId) ?? [];
    post.comments = all.filter((c) =>
      pageId ? c.authorId === pageId : pageName ? c.authorName === pageName : true,
    );
  }

  return { posts: [...posts.values()], pageName, pageId };
}
