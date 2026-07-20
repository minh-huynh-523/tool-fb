"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AttentionThresholds } from "@/lib/attention";

export type WpNeededSP = {
  page?: string; // lọc theo pageId
  range?: string; // 'today' | '7d' | '30d' | 'all' (mặc định 'all')
  from?: string; // YYYY-MM-DD — khoảng tuỳ chọn, đè lên range
  to?: string; // YYYY-MM-DD
  r?: string; // ngưỡng reaction (chỉ xem thử, KHÔNG đổi badge)
  c?: string; // ngưỡng comment
  show?: string; // 'dismissed' = xem đúng những bài đã bỏ qua
  p?: string; // số trang
};

const ALL = "__all__";

// Mặc định 'all' — KHÁC /posts (mặc định 'today'). Đây là hàng đợi việc còn tồn: bài đăng tuần
// trước mà giờ mới lên tương tác thì vẫn phải viết. Lọc ngày để thu hẹp khi hàng đợi dài, chứ
// không phải để giấu bớt việc.
const RANGES: { key: string; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "today", label: "Hôm nay" },
  { key: "7d", label: "7 ngày" },
  { key: "30d", label: "30 ngày" },
];

// Bộ lọc riêng cho /wp-needed. CỐ Ý không tái dùng PostsFilters: nav() bên đó hardcode
// router.push('/posts'), và mặc định ngày của nó ngược với chỗ này.
export function WpNeededFilters({
  sp,
  pages,
  thresholds,
  custom,
}: {
  sp: WpNeededSP;
  pages: { page_id: string; name: string }[];
  thresholds: AttentionThresholds;
  /** Ngưỡng đang khác env -> badge và trang nói hai số khác nhau, phải nói rõ cho user. */
  custom: boolean;
}) {
  const router = useRouter();
  const [r, setR] = useState(String(thresholds.minReactions));
  const [c, setC] = useState(String(thresholds.minComments));

  function nav(patch: Partial<WpNeededSP>) {
    const merged: WpNeededSP = { ...sp, ...patch, p: undefined }; // đổi filter -> về trang 1
    const params = new URLSearchParams();
    if (merged.page) params.set("page", merged.page);
    if (merged.range) params.set("range", merged.range);
    if (merged.from) params.set("from", merged.from);
    if (merged.to) params.set("to", merged.to);
    if (merged.r) params.set("r", merged.r);
    if (merged.c) params.set("c", merged.c);
    if (merged.show) params.set("show", merged.show);
    const qs = params.toString();
    router.push(qs ? `/wp-needed?${qs}` : "/wp-needed");
  }

  const hasCustomDate = !!(sp.from || sp.to);
  const effRange = hasCustomDate ? "custom" : sp.range || "all";

  return (
    <div className="space-y-3">
      {/* Hàng 1: page + xem bài đã bỏ qua + làm mới */}
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
          variant={sp.show === "dismissed" ? "default" : "outline"}
          size="sm"
          onClick={() => nav({ show: sp.show === "dismissed" ? undefined : "dismissed" })}
        >
          Đã bỏ qua
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

      {/* Hàng 2: khoảng ngày ĐĂNG BÀI + ngưỡng tương tác */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {RANGES.map((rg) => (
            <Button
              key={rg.key}
              variant={effRange === rg.key ? "default" : "outline"}
              size="sm"
              onClick={() => nav({ range: rg.key === "all" ? undefined : rg.key, from: undefined, to: undefined })}
            >
              {rg.label}
            </Button>
          ))}
        </div>

        <Input
          type="date"
          value={sp.from ?? ""}
          onChange={(e) => nav({ from: e.target.value || undefined, range: undefined })}
          className="w-[150px]"
          aria-label="Từ ngày"
        />
        <span className="text-sm text-muted-foreground">→</span>
        <Input
          type="date"
          value={sp.to ?? ""}
          onChange={(e) => nav({ to: e.target.value || undefined, range: undefined })}
          className="w-[150px]"
          aria-label="Đến ngày"
        />
        {hasCustomDate && (
          <Button variant="ghost" size="sm" onClick={() => nav({ from: undefined, to: undefined })}>
            Xoá ngày
          </Button>
        )}

        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            nav({ r, c });
          }}
        >
          <span className="ml-2 text-sm text-muted-foreground">Ngưỡng</span>
          <Input
            type="number"
            min={0}
            value={r}
            onChange={(e) => setR(e.target.value)}
            className="w-16"
            aria-label="Ngưỡng reaction"
          />
          <span className="text-sm text-muted-foreground">❤ hoặc</span>
          <Input
            type="number"
            min={1}
            value={c}
            onChange={(e) => setC(e.target.value)}
            className="w-16"
            aria-label="Ngưỡng comment"
          />
          <span className="text-sm text-muted-foreground">💬</span>
          <Button type="submit" variant="outline" size="sm">
            Áp dụng
          </Button>
        </form>

        {custom && (
          <Button variant="ghost" size="sm" onClick={() => nav({ r: undefined, c: undefined })}>
            Về ngưỡng mặc định
          </Button>
        )}
      </div>
    </div>
  );
}
