// Fetch + parse JSON an toàn cho client component. Server/hạ tầng có thể trả HTML
// thay vì JSON (504 timeout của Vercel, trang lỗi, redirect về /login khi hết phiên)
// — khi đó res.json() nổ "Unexpected token '<', <!DOCTYPE ... is not valid JSON".
// Helper này đọc text rồi parse; nếu không phải JSON thì trả { error: <thông báo dễ hiểu> }
// để UI toast bình thường thay vì hiện lỗi parse khó hiểu.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchJson(input: RequestInfo | URL, init?: RequestInit): Promise<{ res: Response; data: any }> {
  const res = await fetch(input, init);
  const text = await res.text();
  try {
    return { res, data: JSON.parse(text) };
  } catch {
    return { res, data: { error: friendlyHttpError(res) } };
  }
}

function friendlyHttpError(res: Response): string {
  if (res.status === 401 || res.url.includes("/login")) {
    return "Phiên đăng nhập đã hết hạn — hãy tải lại trang và đăng nhập lại.";
  }
  if (res.status === 504 || res.status === 502 || res.status === 503) {
    return `Server xử lý quá lâu hoặc gián đoạn (HTTP ${res.status}) — thử lại sau ít phút.`;
  }
  return `Server trả về dữ liệu không hợp lệ (HTTP ${res.status}) — thử lại hoặc tải lại trang.`;
}
