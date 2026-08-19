-- FB Post Dashboard — Part 2 fallback (Gemini) không quá 300 từ
-- Chạy trong Supabase SQL editor, hoặc: supabase db push
--
-- Mẫu kind='part2' SỬA ĐƯỢC trong app (/prompts) nên KHÔNG ghi đè cả body — chỉ chèn thêm một
-- dòng yêu cầu vào cuối khối "Yêu cầu" (ngay trước "Caption gốc:"), và chỉ khi chưa có. Chạy lại
-- nhiều lần vẫn an toàn, mọi chỉnh tay khác trong mẫu giữ nguyên.
-- updated_at do trigger prompt_template_touch tự set (migration 0009), không đụng tay.
--
-- Prompt KHÔNG phải ràng buộc — model vẫn viết lố. Giới hạn được chặn cứng lần nữa ở
-- lib/fb-scraper/part2-fallback.ts (cắt theo câu, giữ dòng CTA).

update prompt_template
set body = replace(
      body,
      'Caption gốc:',
      '* Toàn bộ Part 2 (kể cả dòng CTA) KHÔNG quá 300 từ.' || E'\n\nCaption gốc:'
    )
where kind = 'part2'
  and body like '%Caption gốc:%'
  and body not like '%300 từ%';
