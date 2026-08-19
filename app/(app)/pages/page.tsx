import { listPages } from "@/lib/queries";
import { formatVN } from "@/lib/date";
import { AddPageForm } from "../_components/add-page-form";
import { PageRowActions } from "../_components/page-row-actions";

export const dynamic = "force-dynamic";

export default async function PagesPage() {
  const pages = await listPages();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Pages</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Copy page (page_id + access_token) từ hercules <code>channels</code> vào đây.
        </p>
      </div>

      <AddPageForm />

      <div className="overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100 text-left text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="px-4 py-2 font-medium">Page</th>
              <th className="px-4 py-2 font-medium">page_id</th>
              <th className="px-4 py-2 font-medium">Site WP</th>
              <th className="px-4 py-2 font-medium">Cập nhật</th>
              <th className="px-4 py-2 text-right font-medium">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {pages.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-neutral-400">
                  Chưa có page nào. Thêm ở form phía trên.
                </td>
              </tr>
            )}
            {pages.map((p) => (
              <tr key={p.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {p.picture && <img src={p.picture} alt="" className="h-7 w-7 rounded-full" />}
                    <span className="font-medium">{p.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-500">{p.page_id}</td>
                <td className="px-4 py-3 text-xs text-neutral-500">
                  {p.wp_base_url ? (
                    <span className="font-mono">{p.wp_base_url.replace(/^https?:\/\//, "")}</span>
                  ) : (
                    <span className="text-neutral-400">mặc định (env)</span>
                  )}
                </td>
                <td className="px-4 py-3 text-neutral-500">{formatVN(p.updated_at)}</td>
                <td className="px-4 py-3">
                  <PageRowActions
                    pageId={p.page_id}
                    wpSite={{
                      wp_xmlrpc_url: p.wp_xmlrpc_url,
                      wp_base_url: p.wp_base_url,
                      wp_category: p.wp_category,
                      wp_user: p.wp_user,
                      wp_has_password: p.wp_has_password,
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
