import 'server-only';

// Điểm import Gemini CHO NEXT.JS (API routes, server components) — marker 'server-only' chặn lỡ
// tay import vào Client Component. Implementation thật nằm ở lib/gemini-core.ts (không có marker
// này) để script worker chạy bằng tsx (Node thuần, không qua Next) cũng import được — xem
// lib/fb-scraper/part2-fallback.ts.
export * from './gemini-core';
