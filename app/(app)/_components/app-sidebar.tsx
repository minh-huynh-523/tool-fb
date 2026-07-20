"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, FileText, LayoutDashboard, Link2, Menu, Sparkles, Swords, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LogoutButton } from "./logout-button";
import { WpNeededBadge } from "./wp-needed-badge";

const WP_NEEDED_HREF = "/wp-needed";

const NAV = [
  { href: "/posts", label: "Bài post", icon: FileText },
  // Ngay dưới "Bài post": đây là việc phát sinh TỪ bài post, và là thứ đáng nhìn thứ hai khi mở app.
  { href: WP_NEEDED_HREF, label: "Cần đăng link WP", icon: Link2 },
  { href: "/pages", label: "Pages", icon: Building2 },
  { href: "/competitors", label: "Đối thủ", icon: Swords },
  { href: "/prompts", label: "Mẫu prompt", icon: Sparkles },
];

export function AppSidebar({ username, wpNeeded = 0 }: { username: string; wpNeeded?: number }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  // Nội dung cột sidebar — dùng lại cho cả bản desktop (fixed) và drawer mobile.
  const inner = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <LayoutDashboard className="size-5" />
        </div>
        <div className="leading-tight">
          <div className="font-semibold">FB Dashboard</div>
          <div className="text-xs text-muted-foreground">Life Choices</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
              isActive(href)
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{label}</span>
            {href === WP_NEEDED_HREF && <WpNeededBadge initial={wpNeeded} />}
          </Link>
        ))}
      </nav>

      <div className="border-t p-3">
        <div className="flex items-center gap-2 px-1 pb-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase">
            {username.slice(0, 2)}
          </div>
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{username}</div>
        </div>
        <LogoutButton />
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop: sidebar cố định bên trái */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-sidebar md:flex">
        {inner}
      </aside>

      {/* Mobile: thanh trên cùng có nút mở menu */}
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b bg-background/80 px-4 py-3 backdrop-blur md:hidden">
        <button onClick={() => setOpen(true)} aria-label="Mở menu" className="rounded-lg p-1.5 hover:bg-accent">
          <Menu className="size-5" />
        </button>
        <span className="font-semibold">FB Dashboard</span>
      </header>

      {/* Mobile: drawer trượt ra khi bấm menu */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r bg-sidebar shadow-xl">
            <button
              onClick={() => setOpen(false)}
              aria-label="Đóng menu"
              className="absolute right-2 top-3.5 z-10 rounded-lg p-1.5 hover:bg-accent"
            >
              <X className="size-5" />
            </button>
            {inner}
          </aside>
        </div>
      )}
    </>
  );
}
