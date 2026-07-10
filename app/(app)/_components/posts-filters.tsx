"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type PostsSP = {
  page?: string; // pageId filter
  status?: string; // 'published' | 'scheduled'
  range?: string; // 'today' | '7d' | '30d' | 'all'
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  uncommented?: string;
  p?: string;
};

const ALL = "__all__";

export function PostsFilters({
  sp,
  pages,
}: {
  sp: PostsSP;
  pages: { page_id: string; name: string }[];
}) {
  const router = useRouter();

  function nav(patch: Partial<PostsSP>) {
    const merged: PostsSP = { ...sp, ...patch, p: undefined }; // đổi filter -> về trang 1
    const params = new URLSearchParams();
    if (merged.page) params.set("page", merged.page);
    if (merged.status) params.set("status", merged.status);
    if (merged.range) params.set("range", merged.range);
    if (merged.from) params.set("from", merged.from);
    if (merged.to) params.set("to", merged.to);
    if (merged.uncommented) params.set("uncommented", "1");
    const qs = params.toString();
    router.push(qs ? `/posts?${qs}` : "/posts");
  }

  const hasCustom = !!(sp.from || sp.to);
  const effRange = hasCustom ? "custom" : sp.range || "today";
  const statusVal = sp.status ?? "";

  return (
    <div className="space-y-3">
      {/* Hàng 1: page + trạng thái comment + refresh */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={sp.page || ALL} onValueChange={(v) => nav({ page: v === ALL ? undefined : v })}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Tất cả page" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Tất cả page</SelectItem>
            {pages.map((p) => (
              <SelectItem key={p.page_id} value={p.page_id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant={sp.uncommented ? "default" : "outline"}
          size="sm"
          onClick={() => nav({ uncommented: sp.uncommented ? undefined : "1" })}
        >
          Chưa comment
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => {
            router.refresh();
            toast.info("Đã làm mới");
          }}
        >
          <RefreshCw /> Làm mới
        </Button>
      </div>

      {/* Hàng 2: loại bài + thời gian */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border p-0.5">
          {(
            [
              ["", "Tất cả"],
              ["published", "Đã đăng"],
              ["scheduled", "Lên lịch"],
            ] as const
          ).map(([val, label]) => (
            <Button
              key={val || "all"}
              variant={statusVal === val ? "default" : "ghost"}
              size="sm"
              onClick={() => nav({ status: val || undefined })}
            >
              {label}
            </Button>
          ))}
        </div>

        <span className="mx-1 h-5 w-px bg-border" />

        <div className="flex items-center gap-1 rounded-lg border p-0.5">
          {(
            [
              ["today", "Hôm nay"],
              ["7d", "7 ngày"],
              ["30d", "30 ngày"],
              ["all", "Tất cả"],
            ] as const
          ).map(([val, label]) => (
            <Button
              key={val}
              variant={effRange === val ? "default" : "ghost"}
              size="sm"
              onClick={() => nav({ range: val === "today" ? undefined : val, from: undefined, to: undefined })}
            >
              {label}
            </Button>
          ))}
        </div>

        <span className="mx-1 h-5 w-px bg-border" />

        <Input
          type="date"
          value={sp.from ?? ""}
          onChange={(e) => nav({ from: e.target.value || undefined, range: undefined })}
          className="w-[150px]"
        />
        <span className="text-sm text-muted-foreground">→</span>
        <Input
          type="date"
          value={sp.to ?? ""}
          onChange={(e) => nav({ to: e.target.value || undefined, range: undefined })}
          className="w-[150px]"
        />
      </div>
    </div>
  );
}
