import 'server-only';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export interface ScrapedArticle {
  title: string;
  contentHtml: string;
  description: string; // mô tả ngắn, đã decode entity
  imageUrl: string | null;
  sourceUrl: string;
  parts: number; // số phần đã gộp (truyện nhiều trang ?part=)
}

interface WpRestPost {
  content?: { rendered?: string };
  _embedded?: { 'wp:featuredmedia'?: Array<{ source_url?: string }> };
}

// Rác cần bỏ khỏi .entry-content (nav phân trang, share, related, ads…).
const CRUFT_SELECTOR =
  '.custom-post-pagination-wrap, .custom-nav-buttons, .custom-page-numbers, .post-navigation, .sharedaddy, .jp-relatedposts, .wp-block-buttons, .adsbygoogle, ins, script, style, noscript';

function cleanDescription(s: string): string {
  const t = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= 300) return t;
  const cut = t.slice(0, 300);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut) + '…';
}

// Rút gọn tiêu đề clickbait dài xuống ~2 dòng (~90 ký tự). Ưu tiên cắt ở dấu phân
// tách mạnh (— – | ·), nếu không thì cắt ở ranh giới từ. Tiêu đề vẫn sửa được ở UI.
function shortenTitle(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.length <= 90) return t; // đã đủ ngắn (~2 dòng)
  const sep = t.search(/\s[—–|·]\s/); // dấu phân tách hook/subtitle (không tính ':' vì quá generic)
  if (sep >= 40 && sep <= 110) return t.slice(0, sep).trim();
  const cut = t.slice(0, 90);
  const sp = cut.lastIndexOf(' ');
  return (sp > 40 ? cut.slice(0, sp) : cut).trim();
}

async function fetchDoc(url: string): Promise<Document> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Không tải được trang (HTTP ${res.status})`);
  const html = await res.text();
  return new JSDOM(html, { url }).window.document;
}

// Lấy nội dung 1 phần từ .entry-content (đã bỏ nav phân trang + rác). Trả {html, text}.
function extractEntryContent(doc: Document): { html: string; text: string } | null {
  const ec = doc.querySelector('.entry-content, article .entry-content, .post-content');
  if (!ec) return null;
  ec.querySelectorAll(CRUFT_SELECTOR).forEach((n) => n.remove());
  const html = ec.innerHTML.trim();
  const text = (ec.textContent ?? '').replace(/\s+/g, ' ').trim();
  return html ? { html, text } : null;
}

// URL phần kế tiếp — CHỈ theo nếu cùng bài (khác nhau ở ?part=), tránh nhảy sang bài khác.
function nextPartUrl(doc: Document, currentUrl: string): string | null {
  const a = doc.querySelector('.next-btn a, .nav-next a, a[rel="next"]');
  const href = a?.getAttribute('href');
  if (!href) return null;
  let abs: URL;
  try {
    abs = new URL(href, currentUrl);
  } catch {
    return null;
  }
  if (abs.pathname !== new URL(currentUrl).pathname) return null;
  return abs.toString();
}

// Fallback nội dung faithful từ WP REST (bài không phân trang).
async function tryWpRestContent(u: URL): Promise<{ contentHtml: string; imageUrl: string | null } | null> {
  const slug = u.pathname.replace(/^\/+|\/+$/g, '').split('/').pop();
  if (!slug) return null;
  const api = `${u.origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_embed=wp:featuredmedia`;
  const res = await fetch(api, { headers: { 'User-Agent': UA }, cache: 'no-store' });
  if (!res.ok) return null;
  const arr = (await res.json().catch(() => [])) as WpRestPost[];
  const post = Array.isArray(arr) ? arr[0] : undefined;
  if (!post?.content?.rendered) return null;
  return {
    contentHtml: post.content.rendered,
    imageUrl: post._embedded?.['wp:featuredmedia']?.[0]?.source_url ?? null,
  };
}

export async function scrapeArticle(rawUrl: string): Promise<ScrapedArticle> {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new Error('URL không hợp lệ');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL phải là http(s)');

  const firstDoc = await fetchDoc(u.toString());

  // Meta (getAttribute -> đã decode entity). Đọc trước khi mutate DOM.
  const meta = (sel: string) => firstDoc.querySelector(sel)?.getAttribute('content')?.trim() || null;
  const ogTitle = meta('meta[property="og:title"]');
  const ogDesc = meta('meta[property="og:description"]') ?? meta('meta[name="description"]');
  const ogImage = meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]');
  const docTitle = firstDoc.title?.trim() || null;

  let contentHtml = '';
  let featured: string | null = null;
  let firstText = '';
  let parts = 1;

  // 1) WP REST content.rendered — với post phân trang ?part, REST đã trả FULL truyện (mọi phần).
  const wp = await tryWpRestContent(u).catch(() => null);
  if (wp) {
    contentHtml = wp.contentHtml;
    featured = wp.imageUrl;
  }

  // 2) Fallback (site không có REST): đi theo nút "next page" (?part=), gom .entry-content mọi phần.
  if (!contentHtml) {
    const first = extractEntryContent(firstDoc);
    if (first) {
      const chunks = [first.html];
      firstText = first.text;
      const seen = new Set([u.toString()]);
      let next: string | null = nextPartUrl(firstDoc, u.toString());
      while (next && !seen.has(next) && chunks.length < 20) {
        seen.add(next);
        let doc: Document;
        try {
          doc = await fetchDoc(next);
        } catch {
          break;
        }
        // Đọc link phần kế TRƯỚC khi extractEntryContent (nó xoá nav phân trang khỏi DOM).
        const nx = nextPartUrl(doc, next);
        const c = extractEntryContent(doc);
        if (c) chunks.push(c.html);
        next = nx;
      }
      parts = chunks.length;
      contentHtml = chunks.join('\n');
    }
  }

  // 3) Fallback cuối: Readability (site bất kỳ) — fetch lại vì firstDoc có thể đã bị mutate.
  if (!contentHtml) {
    try {
      const doc2 = await fetchDoc(u.toString());
      const art = new Readability(doc2).parse();
      if (art?.content) {
        contentHtml = art.content;
        if (!firstText) firstText = art.textContent ?? '';
      }
    } catch {
      // bỏ qua
    }
  }
  if (!contentHtml) throw new Error('Không cào được nội dung từ URL này (site chặn hoặc không đọc được bài).');

  const title = shortenTitle(ogTitle || docTitle || '');
  const description = cleanDescription(ogDesc || firstText || '');
  const imageUrl = ogImage || featured;

  return { title, contentHtml, description, imageUrl, sourceUrl: u.toString(), parts };
}
