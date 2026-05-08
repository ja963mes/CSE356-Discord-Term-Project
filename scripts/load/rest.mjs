/**
 * REST read load test — community list, channel list, DM history reads.
 *
 * Usage: node scripts/load/rest.mjs https://... [--rps 100] [--dur 15]
 */
import { makeStats, printProgress, printSummary, flag, uid, Jar, apiFetch } from './_shared.mjs';

const BASE_URL    = (process.argv.find(a => a.startsWith('http')) || 'http://localhost:5173').replace(/\/$/, '');
const TARGET_RPS  = flag('--rps', 100);
const DURATION_S  = flag('--dur', 15);
const CONCURRENCY = flag('--concurrency', 10);

async function setupReader() {
  const jar = new Jar();
  const username = `rd-${uid()}`;
  const rReg = await apiFetch(BASE_URL, jar, 'POST', '/auth/register', { username, password: 'Load1234!', displayName: username });
  if (rReg.status !== 200 && rReg.status !== 201) throw new Error(`register failed: ${rReg.status}`);
  const userId = rReg.data?.internal_id || rReg.data?.id || rReg.data?.user?.internal_id;

  const jarB = new Jar();
  const usernameB = `rd-b-${uid()}`;
  const rRegB = await apiFetch(BASE_URL, jarB, 'POST', '/auth/register', { username: usernameB, password: 'Load1234!', displayName: usernameB });
  const userBId = rRegB.data?.internal_id || rRegB.data?.id || rRegB.data?.user?.internal_id;

  // Create community
  const rC = await apiFetch(BASE_URL, jar, 'POST', '/create-community', { name: `Rd-${uid()}` });
  const communityId = rC.data?.community?.id || rC.data?.id;
  const rCh = await apiFetch(BASE_URL, jar, 'GET', `/communities/${communityId}/channels`, null);
  const channelId = (Array.isArray(rCh.data) ? rCh.data : (rCh.data?.channels || []))[0]?.id;

  // Seed some messages
  for (let i = 0; i < 5; i++) {
    await apiFetch(BASE_URL, jar, 'POST', '/messages', { channelId, content: `seed-${i}` });
  }

  // Create DM and seed messages
  const rDM = await apiFetch(BASE_URL, jar, 'POST', '/dms', { type: 'one_to_one', participantIds: [userBId] });
  const dmId = rDM.data?.conversation?.conversationId || rDM.data?.conversationId || rDM.data?.id;
  for (let i = 0; i < 5; i++) {
    await apiFetch(BASE_URL, jar, 'POST', `/dms/${dmId}/messages`, { content: `seed-dm-${i}` });
  }

  return { jar, communityId, channelId, dmId };
}

const stats = makeStats();

async function worker(ctx, stopAt) {
  const { jar, communityId, channelId, dmId } = ctx;
  const intervalMs = 1000 / (TARGET_RPS / CONCURRENCY);

  while (Date.now() < stopAt) {
    const t0 = Date.now();

    // Round-robin through read endpoints
    const pick = Math.floor(Math.random() * 4);
    let label, path;
    if (pick === 0)      { label = 'GET /communities';          path = '/communities'; }
    else if (pick === 1) { label = 'GET /channels';             path = `/communities/${communityId}/channels`; }
    else if (pick === 2) { label = 'GET /messages';             path = `/messages?channelId=${channelId}&limit=20`; }
    else                 { label = 'GET /dms/:id/messages';     path = `/dms/${dmId}/messages?limit=20`; }

    try {
      const r = await apiFetch(BASE_URL, jar, 'GET', path, null);
      stats.record(label, Date.now() - t0, r.status === 200, r.status !== 200 ? `HTTP ${r.status}` : '');
    } catch (e) {
      stats.record(label, Date.now() - t0, false, e.message);
    }

    const wait = intervalMs - (Date.now() - t0);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

async function main() {
  console.log(`[rest] rps=${TARGET_RPS} concurrency=${CONCURRENCY} dur=${DURATION_S}s — setting up...`);
  const ctx = await setupReader();
  console.log(`[rest] setup done, starting load`);

  const stopAt = Date.now() + DURATION_S * 1000;
  const ticker = setInterval(() => printProgress('rest', stats), 1000);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(ctx, stopAt)));
  await new Promise(r => setTimeout(r, 500));
  clearInterval(ticker);
  printSummary('rest', stats);
  process.exit(stats.hasFailures() ? 1 : 0);
}

main().catch(e => { console.error('[rest] crashed:', e.message); process.exit(1); });
