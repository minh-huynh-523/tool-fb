import { getPromptTemplate } from "@/lib/queries";
import { PromptTemplateForm } from "../_components/prompt-template-form";

export const dynamic = "force-dynamic";

export default async function PromptsPage() {
  const tpl = await getPromptTemplate("main");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Mẫu prompt</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Mega-prompt gửi Gemini khi bấm <b>Tạo prompt</b> ở trang Đối thủ. Sửa ở đây, không cần deploy lại.
        </p>
      </div>

      {tpl ? (
        <PromptTemplateForm initialBody={tpl.body} updatedAt={tpl.updated_at} />
      ) : (
        <div className="rounded-2xl border border-dashed border-neutral-300 p-10 text-center text-neutral-400 dark:border-neutral-700">
          Chưa có mẫu prompt — chạy migration <code>0009_competitor_prompt.sql</code> trên Supabase trước.
        </div>
      )}
    </div>
  );
}
