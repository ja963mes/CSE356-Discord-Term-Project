/**
 * Auth load test — register + login throughput.
 *
 * Usage: node scripts/load/auth.mjs https://... [--rps 50] [--dur 15]
 */
import { makeStats, printProgress, printSummary, flag, uid, Jar, apiFetch } from './_shared.mjs';

const BASE_URL   = (process.argv.find(a => a.startsWith('http')) || 'http://localhost:5173').replace(/\/$/, '');
const TARGET_RPS = flag('--rps', 50);
const DURATION_S = flag('--dur', 15);
const CONCURRENCY = flag('--concurrency', 10);

const stats = makeStats();

async function worker(stopAt) {
  while (Date.now() < stopAt) {
    const t0 = Date.now();
    const username = `ld-${uid()}`;
    const jar = new Jar();

    // Register
    try {
      const r = await apiFetch(BASE_URL, jar, 'POST', '/auth/register', { username, password: 'Load1234!', displayName: username });
      if (r.status === 200 || r.status === 201) {
        stats.record('register', Date.now() - t0, true);
      } else {
        stats.record('register', Date.now() - t0, false, `HTTP ${r.status}`);
      }
    } catch (e) {
      stats.record('register', Date.now() - t0, false, e.message);
    }

    // Login with same credentials
    const t1 = Date.now();
    try {
      const r = await apiFetch(BASE_URL, new Jar(), 'POST', '/auth/login', { username, password: 'Load1234!' });
      if (r.status === 200) {
        stats.record('login', Date.now() - t1, true);
      } else {
        stats.record('login', Date.now() - t1, false, `HTTP ${r.status}`);
      }
    } catch (e) {
      stats.record('login', Date.now() - t1, false, e.message);
    }

    // Rate limit
    const elapsed = Date.now() - t0;
    const wait = (1000 / (TARGET_RPS / CONCURRENCY)) - elapsed;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

async function main() {
  console.log(`[auth] rps=${TARGET_RPS} concurrency=${CONCURRENCY} dur=${DURATION_S}s`);
  const stopAt = Date.now() + DURATION_S * 1000;
  const ticker = setInterval(() => printProgress('auth', stats), 1000);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(stopAt)));
  await new Promise(r => setTimeout(r, 500));
  clearInterval(ticker);
  printSummary('auth', stats);
  process.exit(stats.hasFailures() ? 1 : 0);
}

main().catch(e => { console.error('[auth] crashed:', e.message); process.exit(1); });
