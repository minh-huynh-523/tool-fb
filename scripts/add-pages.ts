/**
 * Thêm page vào facebook_page từ dòng dump của hercules `channels`.
 *
 *   npx tsx --env-file=.env.local scripts/add-pages.ts
 *
 * Đi qua đúng luồng của POST /api/pages: gọi Graph để xác thực token + lấy name/picture,
 * rồi encryptToken trước khi lưu. KHÔNG insert thẳng bằng SQL — token sẽ nằm plaintext
 * và lib/crypto không giải mã lại được đồng nhất với các page cũ.
 */
import { createWorkerSupabase } from '../lib/fb-scraper/supabase';
import { encryptToken } from '../lib/crypto';
import { getPageInfo, FacebookError } from '../lib/facebook/client';

const PAGES: { page_id: string; name: string; access_token: string }[] = [
  {
    page_id: '350767141731232',
    name: 'Delta D',
    access_token:
      'EAAO5pqlZCpgABSIwZBIiCwGFdHo1u5Fup7ZBD7X2RLT9TbGJEryCC34R4xOLKjXmF9ozfeXBVxFHYOElXJfQ1A7XXG2ga7DxZAWbYNYkCrVRKCRFRhLZCtH46BfgKNhzujQyXBBNT8mJznCKFTYsWNe0ZCMJc3JqwtuhRYvKo6TZCqEEqADDZARMbONGobN0M99RZAEyS2mZBI',
  },
  {
    page_id: '107215740962199',
    name: 'Amazing Videos',
    access_token:
      'EAAO5pqlZCpgABSL6ZBQjHMgrW4SIAgZAmZBs6kamddmcorfJTnaG33kWdcJAqy0ZBXeR8hliqpUCFN6DI8crJDNISZATtK48TFZBMbQF4mlj4JtNEI81NMg23b932kU03HY7jiCvPg9GGs6jchVUeb3AE6tN6z96uIwg3uF2fqkXgp2b4YZCT5BEc4ZAjQwCuVKJGYuMkWZCAZD',
  },
  {
    page_id: '307703289635630',
    name: 'News Makers',
    access_token:
      'EAAO5pqlZCpgABSOXM0Oa3QocaZBWZA2J3FBYFyu11oIbZACF3rKiUGZBh2d3JzAdF9181xH4o0iUCcNQcTl689KoTJoakMuf2hPgFtwseRf9CamxGZCKZAiegzjUliK7HvjeZB5upD8tzwIjZBeE728hxLtGQoigZBRQeScaZCRnwkOvmMOoKXMTSHbiLA9yLTlp64gSFklNnZBD',
  },
];

async function main() {
  const db = createWorkerSupabase();

  for (const p of PAGES) {
    let info: { id: string; name: string; pictureUrl: string | null };
    try {
      info = await getPageInfo(p.page_id, p.access_token);
    } catch (e) {
      const msg =
        e instanceof FacebookError ? `[FB ${e.code ?? ''}] ${e.message}` : (e as Error).message;
      console.error(`✗ ${p.name} (${p.page_id}) — token không dùng được: ${msg}`);
      continue;
    }

    const { error } = await db.from('facebook_page').upsert(
      {
        page_id: p.page_id,
        name: p.name || info.name,
        picture: info.pictureUrl,
        access_token: encryptToken(p.access_token),
      },
      { onConflict: 'page_id' },
    );

    if (error) console.error(`✗ ${p.name} (${p.page_id}) — lưu lỗi: ${error.message}`);
    else console.log(`✓ ${p.name} (${p.page_id}) — FB trả về "${info.name}"`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
