import Link from "next/link";
import { listCompetitorPages } from "@/lib/queries";
import { formatVN } from "@/lib/date";
import { AddCompetitorForm } from "../_components/add-competitor-form";
import { CompetitorActions } from "../_components/competitor-actions";

export const dynamic = "force-dynamic";

export default async function CompetitorsPage() {
  const pages = await listCompetitorPages();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Đối thủ</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Theo dõi caption + first-comment của page đối thủ. Dữ liệu do worker Playwright ở laptop cào về
          (Vercel chỉ hiển thị). Nút <b>Cào ngay</b> gửi yêu cầu — laptop nhận trong ~1 phút.
        </p>
      </div>

      <AddCompetitorForm />

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-left text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="px-4 py-2 font-medium">Page</th>
              <th className="px-4 py-2 font-medium">Bài đã cào</th>
              <th className="px-4 py-2 font-medium">Cào lần cuối</th>
              <th className="px-4 py-2 font-medium">Trạng thái</th>
              <th className="px-4 py-2 text-right font-medium">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {pages.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-neutral-400">
                  Chưa có page đối thủ. Thêm ở form phía trên.
                </td>
              </tr>
            )}
            {pages.map((p) => (
              <tr key={p.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-4 py-3">
                  <Link href={`/competitors/${p.id}`} className="flex items-center gap-2 hover:underline">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {p.picture && <img src={p.picture} alt="" className="h-7 w-7 rounded-full" />}
                    <span>
                      <span className="font-medium">{p.name ?? p.handle}</span>
                      <span className="ml-2 font-mono text-xs text-neutral-400">{p.handle}</span>
                    </span>
                  </Link>
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-300">{p.post_count}</td>
                <td className="px-4 py-3 text-neutral-500">
                  {p.last_scraped_at ? formatVN(p.last_scraped_at) : <span className="text-neutral-400">chưa cào</span>}
                </td>
                <td className="px-4 py-3">
                  {p.last_error ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300" title={p.last_error}>
                      lỗi
                    </span>
                  ) : p.active ? (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700 dark:bg-green-950 dark:text-green-300">
                      đang theo dõi
                    </span>
                  ) : (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                      tạm dừng
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <CompetitorActions id={p.id} active={p.active} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
