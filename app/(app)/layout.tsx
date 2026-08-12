import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "@/lib/session";
import { countPostsNeedingWp, envThresholds, getScraperStatus } from "@/lib/queries";
import { AppSidebar } from "./_components/app-sidebar";
import { SessionExpiredBanner } from "./_components/session-expired-banner";
import { Toaster } from "@/components/ui/sonner";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");

  // Số cho badge sidebar. catch(0) là CỐ Ý: DB lỗi hay migration chưa chạy thì badge tắt đi,
  // chứ một cái badge không đáng để 500 toàn bộ app.
  const wpNeeded = await countPostsNeedingWp(envThresholds()).catch(() => 0);
  // Cùng lý do: banner phụ, migration 0021 chưa chạy thì im lặng ẩn banner chứ không sập app.
  const scraperStatus = await getScraperStatus().catch(() => ({ sessionExpired: false, sessionExpiredAt: null }));

  return (
    <div className="min-h-screen">
      <AppSidebar username={session.u} wpNeeded={wpNeeded} />
      <div className="flex min-h-screen flex-col md:pl-64">
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">
          {scraperStatus.sessionExpired && (
            <SessionExpiredBanner sessionExpiredAt={scraperStatus.sessionExpiredAt} />
          )}
          {children}
        </main>
      </div>
      <Toaster richColors position="top-right" />
    </div>
  );
}
