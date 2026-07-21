import Link from "next/link";
import { listCompetitorPages, RECENT_WINDOW_HOURS } from "@/lib/queries";
import { sheetState } from "@/lib/sheet-state";
import { formatVN, nowMs } from "@/lib/date";
import { AddCompetitorForm } from "../_components/add-competitor-form";
import { CompetitorActions } from "../_components/competitor-actions";
import { SheetStateBadge } from "../_components/sheet-state-badge";

export const dynamic = "force-dynamic";

// Filter + sort qua URL (giống trang /posts): server component tự lọc, không cần JS phía client,
// và link chia sẻ / bookmark được. Danh sách chỉ vài chục page nên lọc trong JS là đủ.
interface CompetitorsSP {
  scraped?: string; // "1" = đã cào được bài | "0" = chưa cào được bài nào
  sort?: string; // "posts" = nhiều bài nhất | mặc định: đang theo dõi trước, rồi tên
  genre?: string; // loại nội dung, khớp đúng chữ với competitor_page.genre
}

const FILTERS: Array<{ label: string; value: string | undefined }> = [
  { label: "Tất cả", value: undefined },
  { label: "Đã cào", value: "1" },
  { label: "Chưa cào", value: "0" },
];
const SORTS: Array<{ label: string; value: string | undefined }> = [
  { label: "Mặc định", value: undefined },
  { label: "Nhiều bài nhất", value: "posts" },
];

function buildHref(sp: CompetitorsSP, patch: Partial<CompetitorsSP>): string {
  const merged = { ...sp, ...patch };
  const params = new URLSearchParams();
  if (merged.scraped) params.set("scraped", merged.scraped);
  if (merged.sort) params.set("sort", merged.sort);
  if (merged.genre) params.set("genre", merged.genre);
  const qs = params.toString();
  return qs ? `/competitors?${qs}` : "/competitors";
}

function Pills({
  title,
  options,
  current,
  hrefFor,
}: {
  title: string;
  options: Array<{ label: string; value: string | undefined }>;
  current: string | undefined;
  hrefFor: (value: string | undefined) => string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-neutral-500">{title}</span>
      {options.map((o) => {
        const active = (current ?? undefined) === o.value;
        return (
          <Link
            key={o.label}
            href={hrefFor(o.value)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              active
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            }`}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}

export default async function CompetitorsPage({ searchParams }: { searchParams: Promise<CompetitorsSP> }) {
  const sp = await searchParams;
  const all = await listCompetitorPages();

  // Mốc "bây giờ" để biết dấu 'đã copy' còn trong ngày không. Đọc đồng hồ ở đây an toàn vì
  // đây là server component force-dynamic — render lại mỗi request, không hydrate ở client.
  const now = nowMs();

  // "Đã cào" = đã có bài trong DB. Khác với "active" (đang theo dõi) và khác "cào lần cuối"
  // (có thể đã chạy nhưng bị chặn nên 0 bài).
  // Loại lấy thẳng từ dữ liệu, không hardcode: thêm loại mới trong DB là pill tự hiện.
  const genres = [...new Set(all.map((p) => p.genre).filter((g): g is string => !!g))].sort();
  const genreOptions = [{ label: "Tất cả", value: undefined }, ...genres.map((g) => ({ label: g, value: g }))];

  const pages = all
    .filter((p) => (sp.genre ? p.genre === sp.genre : true))
    .filter((p) => (sp.scraped === "1" ? p.post_count > 0 : sp.scraped === "0" ? p.post_count === 0 : true))
    // listCompetitorPages() đã sort sẵn (active trước, rồi tên) → chỉ đảo khi chọn "nhiều bài nhất".
    .sort((a, b) => (sp.sort === "posts" ? b.post_count - a.post_count : 0));

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

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Pills
          title="Lọc:"
          options={FILTERS}
          current={sp.scraped}
          hrefFor={(v) => buildHref(sp, { scraped: v })}
        />
        {genres.length > 0 && (
          <Pills
            title="Loại:"
            options={genreOptions}
            current={sp.genre}
            hrefFor={(v) => buildHref(sp, { genre: v })}
          />
        )}
        <Pills title="Sắp xếp:" options={SORTS} current={sp.sort} hrefFor={(v) => buildHref(sp, { sort: v })} />
        <span className="text-xs text-neutral-400">
          {pages.length}/{all.length} page
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-left text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="px-4 py-2 font-medium">Page</th>
              <th className="px-4 py-2 font-medium">Loại</th>
              <th className="px-4 py-2 font-medium">Bài đã cào</th>
              <th className="px-4 py-2 font-medium" title={`Bài đăng trong ${RECENT_WINDOW_HOURS} giờ gần nhất`}>
                Bài ≤ {RECENT_WINDOW_HOURS}h
              </th>
              <th className="px-4 py-2 font-medium">Cào lần cuối</th>
              <th className="px-4 py-2 font-medium">Trạng thái</th>
              <th className="px-4 py-2 font-medium">Sheet</th>
              <th className="px-4 py-2 text-right font-medium">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {pages.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-neutral-400">
                  {all.length === 0
                    ? "Chưa có page đối thủ. Thêm ở form phía trên."
                    : "Không page nào khớp bộ lọc."}
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
                <td className="px-4 py-3">
                  {p.genre ? (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                      {p.genre}
                    </span>
                  ) : (
                    <span className="text-xs text-neutral-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-300">{p.post_count}</td>
                <td className="px-4 py-3">
                  {p.recent_post_count > 0 ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 tabular-nums dark:bg-blue-950 dark:text-blue-300">
                      {p.recent_post_count}
                    </span>
                  ) : (
                    // 0 để mờ chứ không ẩn: "cào rồi mà 6h qua page này không đăng gì" là thông tin,
                    // ô trống thì lại giống lỗi hiển thị.
                    <span className="text-xs text-neutral-400">0</span>
                  )}
                </td>
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
                  <SheetStateBadge
                    state={sheetState(p.sheet_copied_at, p.newest_post_at, p.last_scraped_at, now)}
                    copiedAt={p.sheet_copied_at}
                  />
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
