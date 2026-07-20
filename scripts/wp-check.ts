import xmlrpc from 'xmlrpc';

const URL_ = 'https://story.investvinhphuc.vn/xmlrpc.php';
const user = process.env.WP_USER ?? '';
const pass = process.env.WP_PASSWORD ?? '';

function call<T>(method: string, params: unknown[]): Promise<T> {
  const client = xmlrpc.createSecureClient({ url: URL_ });
  return new Promise((res, rej) =>
    client.methodCall(method, params, (err: unknown, v: unknown) => {
      if (err) {
        const e = err as { faultString?: string; message?: string };
        rej(new Error(e.faultString ?? e.message ?? 'Lỗi XML-RPC'));
      } else res(v as T);
    }),
  );
}

async function main() {
  console.log(`XML-RPC: ${URL_}\nWP_USER: ${user}\n`);

  const blogs = await call<{ blogName: string; blogid: string; xmlrpc: string }[]>(
    'wp.getUsersBlogs',
    [user, pass],
  );
  console.log('✓ Đăng nhập OK —', blogs.map((b) => `${b.blogName} (id ${b.blogid})`).join(', '));

  const cats = await call<{ name: string }[]>('wp.getTerms', [
    blogs[0].blogid,
    user,
    pass,
    'category',
  ]);
  const names = cats.map((c) => c.name);
  const want = process.env.WP_CATEGORY ?? 'Story';
  console.log('✓ Category có sẵn:', names.join(', '));
  console.log(
    names.includes(want) ? `✓ Có category "${want}"` : `✗ THIẾU category "${want}" trên site này`,
  );
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
