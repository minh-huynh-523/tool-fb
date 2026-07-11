import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-guard";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { wpGetPostInfo } from "@/lib/wordpress/client";

export const runtime = "nodejs";
export const maxDuration = 30;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// So khớp content bất chấp entity/dấu câu: decode entity số + named phổ biến,
// bỏ dấu, giữ lại mỗi chữ+số -> substring match không bị lệch vì &#8217; hay nháy cong.
function normalizeForMatch(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(amp|quot|apos|nbsp|hellip|rsquo|lsquo|rdquo|ldquo|ndash|mdash);/g, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// POST /api/posts/[postDbId]/wordpress/verify
// Verify permalink TRƯỚC khi copy/đăng comment: hỏi WP status thật + fetch link công khai (ẩn danh)
// + check nội dung trang chứa title bài -> đảm bảo link sống, đúng bài, không 404.
// Nếu WP trả link mới (đã publish / slug đổi) thì tự cập nhật wp_permalink + wp_status trong DB.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ postDbId: string }> }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.res;

  const { postDbId } = await params;

  const db = createSupabaseAdmin();
  const { data: row, error: rowErr } = await db
    .from("scraped_article")
    .select("wp_post_id, wp_status, wp_permalink, title")
    .eq("post_id", postDbId)
    .maybeSingle();
  if (rowErr) return NextResponse.json({ error: rowErr.message }, { status: 500 });
  if (!row?.wp_post_id) return NextResponse.json({ error: "Post chưa có bài WP" }, { status: 404 });

  // 1) Hỏi WP — nguồn sự thật về status + link hiện tại (bắt được cả slug bị WP đổi).
  const wp = await wpGetPostInfo(row.wp_post_id);
  if (!wp.status) {
    return NextResponse.json(
      { ok: false, reason: "wp_unreachable", message: "Không hỏi được WordPress (bài có thể đã bị xoá)" },
      { status: 502 },
    );
  }

  const base = process.env.WP_BASE_URL ?? "";
  const prettyFromSlug = wp.slug && base ? `${base}/${wp.slug}/` : null;
  const permalink =
    (wp.link && !wp.link.includes("?p=") ? wp.link : null) ??
    prettyFromSlug ??
    row.wp_permalink ??
    (base ? `${base}/?p=${row.wp_post_id}` : null);

  // Tự chữa DB nếu link/status trên WP đã khác row đang lưu (vd row cũ ?p=, hoặc vừa publish trên wp-admin).
  if (permalink !== row.wp_permalink || wp.status !== row.wp_status) {
    await db
      .from("scraped_article")
      .update({ wp_permalink: permalink, wp_status: wp.status, updated_at: new Date().toISOString() })
      .eq("post_id", postDbId);
  }

  if (wp.status !== "publish") {
    return NextResponse.json({
      ok: false,
      reason: "not_published",
      wpStatus: wp.status,
      permalink,
      message: `Bài WP còn ở dạng ${wp.status} — link sẽ 404. Publish bài trên WP rồi thử lại.`,
    });
  }

  if (!permalink) {
    return NextResponse.json({ ok: false, reason: "no_permalink", message: "Không xác định được permalink" });
  }

  // 2) Fetch link như người lạ (không auth) — phải 200 và nội dung chứa title bài.
  let html = "";
  let httpStatus = 0;
  try {
    const res = await fetch(permalink, {
      headers: { "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    httpStatus = res.status;
    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        reason: "http_error",
        httpStatus,
        permalink,
        message: `Link trả về HTTP ${httpStatus} — kiểm tra lại bài trên wp-admin.`,
      });
    }
    html = await res.text();
  } catch {
    return NextResponse.json({
      ok: false,
      reason: "fetch_failed",
      permalink,
      message: "Không mở được link (timeout/mạng) — thử lại sau.",
    });
  }

  const expected = normalizeForMatch(wp.title || row.title || "");
  const matched = expected.length > 0 && normalizeForMatch(html).includes(expected);
  if (!matched) {
    return NextResponse.json({
      ok: false,
      reason: "content_mismatch",
      httpStatus,
      permalink,
      message: "Trang mở được nhưng nội dung không khớp title bài — link có thể trỏ sai bài.",
    });
  }

  return NextResponse.json({ ok: true, permalink, httpStatus, wpStatus: wp.status });
}
