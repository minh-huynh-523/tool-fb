import { AlertTriangle } from "lucide-react";
import { formatVN } from "@/lib/date";
import { ReloginButton } from "./relogin-button";

/**
 * Banner toàn cục: phiên đăng nhập FB dùng để cào đối thủ đã hết hạn (worker phát hiện qua
 * "login wall" — xem lib/fb-scraper/client.ts SessionExpiredError). Không phải lỗi của riêng 1
 * page — mọi page cào đối thủ đang đứng yên cho tới khi đăng nhập lại.
 */
export function SessionExpiredBanner({ sessionExpiredAt }: { sessionExpiredAt: string | null }) {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1">
        Phiên đăng nhập Facebook dùng để cào đối thủ đã hết hạn{sessionExpiredAt ? ` (từ ${formatVN(sessionExpiredAt)})` : ""}.
        Cào đối thủ đang đứng yên (job GitHub Actions sẽ tự bỏ qua tới khi đăng nhập lại). Bấm nút bên cạnh
        nếu đang chạy <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900/60">npm run dev</code> ở
        máy có màn hình, hoặc chạy tay{" "}
        <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900/60">npm run fb-login</code>. Xong nhớ:{" "}
        <code className="rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900/60">
          gh secret set FB_SCRAPER_STATE {"<"} .fb-scraper/state.json
        </code>{" "}
        để cập nhật secret cho job (nút KHÔNG tự đẩy secret).
      </span>
      <ReloginButton />
    </div>
  );
}
