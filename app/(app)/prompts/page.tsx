import { getPromptTemplate } from "@/lib/queries";
import { PromptTemplateForm } from "../_components/prompt-template-form";

export const dynamic = "force-dynamic";

export default async function PromptsPage() {
  const [main, part2] = await Promise.all([getPromptTemplate("main"), getPromptTemplate("part2")]);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold">Mẫu prompt</h1>
        <p className="mt-1 text-sm text-neutral-500">Sửa ở đây, không cần deploy lại.</p>
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Mega-prompt ảnh/video</h2>
          <p className="text-sm text-neutral-500">Gửi Gemini khi bấm <b>Tạo prompt</b> ở trang Đối thủ.</p>
        </div>
        {main ? (
          <PromptTemplateForm kind="main" initialBody={main.body} updatedAt={main.updated_at} />
        ) : (
          <div className="rounded-2xl border border-dashed border-neutral-300 p-10 text-center text-neutral-400 dark:border-neutral-700">
            Chưa có mẫu prompt — chạy migration <code>0009_competitor_prompt.sql</code> trên Supabase trước.
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Part 2 fallback</h2>
          <p className="text-sm text-neutral-500">
            Gửi Gemini TỰ ĐỘNG lúc worker cào xong, cho bài không có comment nào của page.
          </p>
        </div>
        {part2 ? (
          <PromptTemplateForm kind="part2" initialBody={part2.body} updatedAt={part2.updated_at} />
        ) : (
          <div className="rounded-2xl border border-dashed border-neutral-300 p-10 text-center text-neutral-400 dark:border-neutral-700">
            Chưa có mẫu Part 2 — chạy migration <code>0022_competitor_part2_fallback.sql</code> trên Supabase
            trước.
          </div>
        )}
      </div>
    </div>
  );
}
