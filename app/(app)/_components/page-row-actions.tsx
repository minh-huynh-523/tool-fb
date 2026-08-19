"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchJson } from "@/lib/fetch-json";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface WpSiteConfig {
  wp_xmlrpc_url: string | null;
  wp_base_url: string | null;
  wp_category: string | null;
  wp_user: string | null;
  // Mật khẩu đã lưu KHÔNG bao giờ xuống client (chỉ bản mã hoá nằm ở DB) — chỉ có cờ này để UI
  // nói được "đang dùng mật khẩu riêng" mà không phải hiển thị nó.
  wp_has_password: boolean;
}

export function PageRowActions({ pageId, wpSite }: { pageId: string; wpSite: WpSiteConfig }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"" | "test" | "sync">("");
  const [note, setNote] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  async function testToken() {
    setBusy("test");
    setNote(null);
    try {
      const { data } = await fetchJson(`/api/pages/${encodeURIComponent(pageId)}/test-token`);
      if (data.ok) {
        toast.success(`Token OK — ${data.name}`);
        setNote({ type: "ok", text: `Token OK — ${data.name}` });
      } else {
        toast.error(data.error ?? "Token lỗi");
        setNote({ type: "err", text: data.error ?? "Token lỗi" });
      }
    } catch (e) {
      toast.error((e as Error).message);
      console.log(e)
      setNote({ type: "err", text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  async function sync() {
    setBusy("sync");
    setNote(null);
    try {
      const { res, data } = await fetchJson(`/api/pages/${encodeURIComponent(pageId)}/sync`, { method: "POST" });
      if (res.ok) {
        const count = data.result?.count ?? 0;
        toast.success(`Đồng bộ: ${count} bài`);
        setNote({ type: "ok", text: `Đồng bộ: ${count} bài` });
        if (data.result?.warning) toast.info(data.result.warning);
        router.refresh();
      } else {
        const err = data.result?.error ?? data.error ?? "Lỗi đồng bộ";
        toast.error(err);
        setNote({ type: "err", text: err });
      }
    } catch (e) {
      toast.error((e as Error).message);
      setNote({ type: "err", text: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <WpSiteDialog pageId={pageId} wpSite={wpSite} />
        <button
          onClick={testToken}
          disabled={!!busy}
          className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs transition hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {busy === "test" ? "…" : "Test token"}
        </button>
        <button
          onClick={sync}
          disabled={!!busy}
          className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs transition hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {busy === "sync" ? "…" : "Đồng bộ"}
        </button>
      </div>
      {note && (
        <span className={`text-xs ${note.type === "ok" ? "text-green-600" : "text-red-600"}`}>{note.text}</span>
      )}
    </div>
  );
}

// Mỗi page đăng lên 1 site WordPress riêng, kèm credential riêng (migration 0028). Để trống =
// dùng site + user/password mặc định trong .env.local.
function WpSiteDialog({ pageId, wpSite }: { pageId: string; wpSite: WpSiteConfig }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [xmlrpcUrl, setXmlrpcUrl] = useState(wpSite.wp_xmlrpc_url ?? "");
  const [baseUrl, setBaseUrl] = useState(wpSite.wp_base_url ?? "");
  const [category, setCategory] = useState(wpSite.wp_category ?? "");
  const [wpUser, setWpUser] = useState(wpSite.wp_user ?? "");
  const [wpPassword, setWpPassword] = useState("");

  // Mở lại dialog -> nạp lại giá trị hiện tại (bỏ chỉnh sửa dở của lần trước).
  function onOpenChange(next: boolean) {
    if (next) {
      setXmlrpcUrl(wpSite.wp_xmlrpc_url ?? "");
      setBaseUrl(wpSite.wp_base_url ?? "");
      setCategory(wpSite.wp_category ?? "");
      setWpUser(wpSite.wp_user ?? "");
      setWpPassword(""); // luôn mở ra rỗng: server hiểu rỗng = giữ mật khẩu đang lưu
    }
    setOpen(next);
  }

  // Tiện tay: gõ base URL trước thì tự gợi ý xmlrpc.php tương ứng.
  function onBaseUrlBlur() {
    const b = baseUrl.trim().replace(/\/+$/, "");
    if (b && !xmlrpcUrl.trim()) setXmlrpcUrl(`${b}/xmlrpc.php`);
  }

  async function save() {
    setSaving(true);
    try {
      const { res, data } = await fetchJson(`/api/pages/${encodeURIComponent(pageId)}/wp-site`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wp_xmlrpc_url: xmlrpcUrl,
          wp_base_url: baseUrl,
          wp_category: category,
          wp_user: wpUser,
          wp_password: wpPassword,
        }),
      });
      if (!res.ok) {
        toast.error(data.error ?? "Lưu cấu hình thất bại");
        return;
      }
      toast.success("Đã lưu cấu hình WordPress");
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800">
          Cấu hình WP
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Site WordPress của page</DialogTitle>
          <DialogDescription>
            Bài scrape của page này sẽ đăng lên site dưới đây. Để trống hết = dùng site và
            username/password mặc định trong <code>.env.local</code>. Mật khẩu được mã hoá trước khi lưu.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`wp-base-${pageId}`}>Base URL</Label>
            <Input
              id={`wp-base-${pageId}`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={onBaseUrlBlur}
              placeholder="https://site.vn"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`wp-xmlrpc-${pageId}`}>XML-RPC URL</Label>
            <Input
              id={`wp-xmlrpc-${pageId}`}
              value={xmlrpcUrl}
              onChange={(e) => setXmlrpcUrl(e.target.value)}
              placeholder="https://site.vn/xmlrpc.php"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`wp-cat-${pageId}`}>Category</Label>
            <Input
              id={`wp-cat-${pageId}`}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Story"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`wp-user-${pageId}`}>Username WordPress</Label>
            <Input
              id={`wp-user-${pageId}`}
              value={wpUser}
              onChange={(e) => setWpUser(e.target.value)}
              placeholder="để trống = dùng WP_USER ở env"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`wp-pass-${pageId}`}>Mật khẩu WordPress</Label>
            <Input
              id={`wp-pass-${pageId}`}
              type="password"
              value={wpPassword}
              onChange={(e) => setWpPassword(e.target.value)}
              placeholder={wpSite.wp_has_password ? "••••••• (để trống = giữ nguyên)" : "để trống = dùng WP_PASSWORD ở env"}
              autoComplete="new-password"
            />
            <p className="text-xs text-neutral-500">
              {wpSite.wp_has_password
                ? "Page này đang dùng mật khẩu riêng. Chỉ nhập khi muốn đổi — xoá ô username sẽ xoá cả cặp và quay về credential chung."
                : "Nhập username thì phải nhập cả mật khẩu. Mật khẩu lưu dạng mã hoá AES-256-GCM, không đọc ngược ra được."}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Huỷ
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Đang lưu…" : "Lưu"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
