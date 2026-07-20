"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";

const POLL_MS = 60_000;
const SEEN_KEY = "wpNeeded:lastSeen";

/**
 * Badge "còn bao nhiêu bài chờ đăng link WP" ở sidebar.
 *
 * Số ban đầu do layout render sẵn (SSR); component này chỉ lo giữ cho nó tươi:
 *   - poll mỗi 60s — ĐÚNG nhịp, không nhanh hơn: pg_cron gọi /api/cron/sync-pages mỗi phút
 *     (migration 0005) nên dữ liệu không thể đổi nhanh hơn thế, poll dày chỉ đốt invocation;
 *   - fetch lại khi quay lại tab (bỏ tab 2 tiếng rồi mở ra không nên thấy số cũ mèm);
 *   - toast khi số TĂNG, để biết có bài mới đáng viết mà không phải nhìn sidebar.
 */
export function WpNeededBadge({ initial }: { initial: number }) {
  const router = useRouter();
  const [count, setCount] = useState(initial);

  // BẮT BUỘC: App Router không re-render layout dùng chung khi soft-navigate giữa các route anh
  // em, nhưng router.refresh() (nút Bỏ qua, tạo bài WP xong) thì CÓ nạp lại layout. Thiếu đoạn
  // này badge sẽ ngồi ôm state cũ và phớt lờ luôn giá trị SSR mới.
  //
  // Chỉnh state ngay trong render (không dùng useEffect) — đây là cách React khuyến nghị cho
  // "reset state khi prop đổi": React chạy lại render trước khi vẽ, không có nháy hình.
  const [prevInitial, setPrevInitial] = useState(initial);
  if (prevInitial !== initial) {
    setPrevInitial(initial);
    setCount(initial);
  }

  // Mốc "số mình đã thấy lần trước". null = chưa biết -> lần poll đầu chỉ ghi nhận, KHÔNG toast
  // (mở app lên mà bị bắn thông báo về việc đã tồn tại từ hôm qua thì phiền chứ không giúp gì).
  // Đọc lại từ sessionStorage để điều hướng qua lại trong cùng phiên không bắn trùng.
  const seen = useRef<number | null>(null);
  useEffect(() => {
    const raw = sessionStorage.getItem(SEEN_KEY);
    if (raw !== null) seen.current = Number(raw);
  }, []);

  useEffect(() => {
    let alive = true;

    async function poll() {
      if (document.visibilityState === "hidden") return; // tab ẩn thì đừng đốt request
      try {
        const { res, data } = await fetchJson("/api/wp-needed/count");
        if (!alive || !res.ok || typeof data?.count !== "number") return;
        setCount(data.count);

        const before = seen.current;
        seen.current = data.count;
        sessionStorage.setItem(SEEN_KEY, String(data.count));
        // Chỉ báo khi TĂNG. Giảm là do chính mình vừa xử lý xong — không cần thông báo.
        if (before !== null && data.count > before) {
          const delta = data.count - before;
          toast.info(`${delta} bài mới cần đăng link WP`, {
            action: { label: "Xem", onClick: () => router.push("/wp-needed") },
          });
        }
      } catch {
        // Mất mạng chốc lát không đáng để bắn toast đỏ vào mặt user — vòng sau tự khỏi.
      }
    }

    const timer = setInterval(poll, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  if (count <= 0) return null; // badge số 0 chỉ là rác thị giác

  return (
    <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-medium text-white tabular-nums">
      {count > 99 ? "99+" : count}
    </span>
  );
}
