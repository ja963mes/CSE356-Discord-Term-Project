/**
 * Search load test — message search + community directory throughput.
 *
 * Usage: node scripts/load/search.mjs https://... [--rps 30] [--dur 15]
 */
import { makeStats, printProgress, printSummary, flag, uid, Jar, apiFetch } from './_shared.mjs';

const BASE_URL    = (process.argv.find(a => a.startsWith('http')) || 'http://localhost:5173').replace(/\/$/, '');
const TARGET_RPS  = flag('--rps', 30);
const DURATION_S  = flag('--dur', 15);
const CONCURRENCY = flag('--concurrency', 5);

async function setup() {
  const jar = new Jar();
  const username = `srch-${uid()}`;
  const rReg = await apiFetch(BASE_URL, jar, 'POST', '/auth/register', { username, password: 'Load1234!', displayName: username });
  if (rReg.status !== 200 && rReg.status !== 201) throw new Error(`register: ${rReg.status}`);

  const rC = await apiFetch(BASE_URL, jar, 'POST', '/create-community', { name: `Srch-${uid()}` });
  const communityId = rC.data?.community?.id || rC.data?.id;
  const rCh = await apiFetch(BASE_URL, jar, 'GET', `/communities/${communityId}/channels`, null);
  const channelId = (Array.isArray(rCh.data) ? rCh.data : (rCh.data?.channels || []))[0]?.id;

  // Seed searchable messages
  const token = `srchtoken-${uid()}`;
  for (let i = 0; i < 10; i++) {
    await apiFetch(BASE_URL, jar, 'POST', '/messages', { channelId, content: `${token}-${i}` });
  }

  // Wait for ES indexing
  console.log('[search] waiting 3s for ES indexing...');
  await new Promise(r => setTimeout(r, 3000));

  return { jar, communityId, channelId, token };
}

const stats = makeStats();

async function worker(ctx, stopAt) {
  const { jar, communityId, token } = ctx;
  const intervalMs = 1000 / (TARGET_RPS / CONCURRENCY);

  while (Date.now() < stopAt) {
    const t0 = Date.now();
    const pick = Math.random() < 0.7 ? 'msg' : 'dir';

    try {
      if (pick === 'msg') {
        const r = await apiFetch(BASE_URL, jar, 'GET',
          `/search/messages?q=${token}&scope=community&communityId=${communityId}`, null);
        const results = Array.isArray(r.data) ? r.data : (r.data?.results || r.data?.hits || []);
        const ok = r.status === 200 && results.length > 0;
        stats.record('GET /search/messages', Date.now() - t0, ok, ok ? '' : `HTTP ${r.status} results=${results.length}`);
      } else {
        const r = await apiFetch(BASE_URL, jar, 'GET', `/search-communities?q=Srch`, null);
        stats.record('GET /search-communities', Date.now() - t0, r.status === 200, r.status !== 200 ? `HTTP ${r.status}` : '');
      }
    } catch (e) {
      stats.record(pick === 'msg' ? 'GET /search/messages' : 'GET /search-communities', Date.now() - t0, false, e.message);
    }

    const wait = intervalMs - (Date.now() - t0);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

async function main() {
  console.log(`[search] rps=${TARGET_RPS} concurrency=${CONCURRENCY} dur=${DURATION_S}s`);
  const ctx = await setup();

  const stopAt = Date.now() + DURATION_S * 1000;
  const ticker = setInterval(() => printProgress('search', stats), 1000);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(ctx, stopAt)));
  clearInterval(ticker);
  printSummary('search', stats);
  process.exit(stats.hasFailures() ? 1 : 0);
}

main().catch(e => { console.error('[search] crashed:', e.message); process.exit(1); });
