"use client";

import { useSyncExternalStore } from "react";

const TICK_MS = 60_000;

/**
 * Mốc "bây giờ", trả null khi đang render ở server.
 *
 * Đồng hồ là nguồn dữ liệu NGOÀI React nên đọc bằng useSyncExternalStore chứ không phải
 * useState+useEffect. Lấy Date.now() thẳng trong render thì server ra một giờ, client ra giờ
 * khác → lệch hydration (và React Compiler cũng chặn vì hàm không thuần). Snapshot làm tròn
 * theo phút để tham chiếu ổn định giữa 2 lần đọc, nếu không React render vô hạn.
 *
 * Component dùng hook này phải xử lý trường hợp null (hiện "…" hoặc tạm ẩn).
 */
export function useNow(): number | null {
  const tick = useSyncExternalStore(
    (onChange) => {
      const t = setInterval(onChange, TICK_MS);
      return () => clearInterval(t);
    },
    () => Math.floor(Date.now() / TICK_MS),
    () => null,
  );
  return tick === null ? null : tick * TICK_MS;
}
