import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Deno runtime (Supabase Edge Functions) — cú pháp riêng (npm:/jsr: specifier, global Deno,
    // import .ts có đuôi) mà parser/rule của Next.js/Node không hiểu, không phải phần Next app.
    "supabase/functions/**",
  ]),
]);

export default eslintConfig;
