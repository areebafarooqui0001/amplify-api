// Quick check of a running API. Usage: node scripts/smoke.mjs https://your-service.onrender.com
// Optional: SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD also test the reviewer sign-in.
const base = (process.argv[2] || process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const get = (path, init) => fetch(base + path, { signal: AbortSignal.timeout(90_000), ...init });

console.log(`Checking ${base} (a sleeping free service can take up to a minute to wake)\n`);

await check('health reports the database is up', async () => {
  const res = await get('/health');
  const body = await res.json();
  expect(res.status === 200 && body.database === 'up', JSON.stringify(body));
});
await check('published campaigns are listed', async () => {
  const body = await (await get('/campaigns')).json();
  expect(body.total > 0, 'no campaigns (seed the database)');
  expect(!('ownerId' in body.items[0]), 'private field leaked');
});
await check('API docs are served', async () => {
  const res = await get('/docs');
  expect(res.status === 200, `status ${res.status}`);
  expect((await (await get('/openapi.json')).json()).openapi === '3.1.0', 'bad spec');
});
await check('reviewer routes reject anonymous requests', async () => {
  expect((await get('/admin/campaigns')).status === 401, 'expected 401');
});
await check('drafts are not public', async () => {
  expect((await get('/campaigns/00000000-0000-4000-8000-000000000000')).status === 404, 'expected 404');
});
if (process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD) {
  await check('reviewer can sign in and list campaigns', async () => {
    const login = await get('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.SEED_ADMIN_EMAIL, password: process.env.SEED_ADMIN_PASSWORD })
    });
    const { accessToken } = await login.json();
    expect(!!accessToken, 'no token');
    const res = await get('/admin/campaigns', { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(res.status === 200, `status ${res.status}`);
  });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
