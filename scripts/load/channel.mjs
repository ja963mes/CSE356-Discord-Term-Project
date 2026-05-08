/**
 * Channel message load test — sustained throughput with delivery verification.
 *
 * Usage:
 *   node scripts/channel-load-test.mjs https://group-6.cse356.compas.cs.stonybrook.edu [options]
 *
 * Options:
 *   --rps     200   target messages per second (default 200)
 *   --pairs    20   concurrent sender/receiver pairs (default 20)
 *   --dur      15   test duration in seconds (default 15)
 *   --timeout 5000  delivery timeout per message ms (default 5000)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let WebSocket;
try { WebSocket = require('ws'); } catch {
  console.error('ws not found. Run: npm install -g ws');
  process.exit(1);
}

const BASE_URL = (process.argv.find(a => a.startsWith('http')) || 'http://localhost:5173').replace(/\/$/, '');
const WS_URL   = BASE_URL.replace(/^https?/, 'ws') + '/ws';

function flag(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}
const TARGET_RPS  = flag('--rps',     200);
const PAIRS       = flag('--pairs',    20);
const DURATION_S  = flag('--dur',      15);
const DELIVERY_MS = flag('--timeout', 5000);
const INTERVAL_MS = 1000 / (TARGET_RPS / PAIRS);

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const B = s => `\x1b[36m${s}\x1b[0m`;

// ── Helpers ───────────────────────────────────────────────────────────────────

class Jar {
  constructor() { this.cookies = new Map(); }
  absorb(res) {
    const raw = res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const h of raw) {
      const [pair] = h.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function apiFetch(jar, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const c = jar.header();
  if (c) headers['Cookie'] = c;
  const res = await fetch(`${BASE_URL}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  jar.absorb(res);
  let data; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function connectWs(jar) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: jar.header() } });
    // pending: content → { resolve, reject, timer }
    const pending = new Map();
    let ready = false;
    // Wait for own presence_update — server sends this after subscribeUser completes,
    // so subscriptions are in Redis before we start sending.
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!ready && msg.type === 'presence_update') { ready = true; resolve({ ws, pending }); }
      if (msg.type === 'channel:message:create' && msg.message?.content) {
        const p = pending.get(msg.message.content);
        if (p) { clearTimeout(p.timer); p.resolve(msg); pending.delete(msg.message.content); }
      }
    });
    ws.on('error', reject);
    // Fallback: resolve after 3s even without presence_update
    setTimeout(() => { if (!ready) { ready = true; resolve({ ws, pending }); } }, 3000);
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'channel:message:create' && msg.message?.content) {
        const p = pending.get(msg.message.content);
        if (p) { clearTimeout(p.timer); p.resolve(msg); pending.delete(msg.message.content); }
      }
    });
    ws.on('close', () => {
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('WS closed')); }
      pending.clear();
    });
  });
}

// Pre-register by content BEFORE sending to avoid the race where the WS
// event arrives before the listener is set up.
function waitForChannel(conn, content, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { conn.pending.delete(content); reject(new Error('timeout')); }, ms);
    conn.pending.set(content, { resolve, reject, timer });
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

const stats = { sent: 0, delivered: 0, timeout: 0, error: 0, latencies: [] };

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p / 100)];
}

// ── Setup one pair ────────────────────────────────────────────────────────────

async function setupPair(idx) {
  const uid = `ch-${Date.now().toString(36)}-${idx}`;
  const jarA = new Jar(), jarB = new Jar();

  const rA = await apiFetch(jarA, 'POST', '/auth/register', { username: `${uid}-a`, password: 'Load1234!', displayName: `${uid}-a` });
  if (rA.status !== 200 && rA.status !== 201) throw new Error(`register A: ${rA.status}`);

  const rB = await apiFetch(jarB, 'POST', '/auth/register', { username: `${uid}-b`, password: 'Load1234!', displayName: `${uid}-b` });
  if (rB.status !== 200 && rB.status !== 201) throw new Error(`register B: ${rB.status}`);

  // A creates community, B joins
  const rC = await apiFetch(jarA, 'POST', '/create-community', { name: `Ld-${uid}` });
  if (rC.status !== 200 && rC.status !== 201) throw new Error(`create community: ${rC.status}`);
  const communityId = rC.data?.community?.id || rC.data?.id;
  if (!communityId) throw new Error('no communityId');

  const rJ = await apiFetch(jarB, 'POST', `/communities/${communityId}/join`, {});
  if (rJ.status !== 200 && rJ.status !== 201) throw new Error(`join: ${rJ.status}`);

  const rCh = await apiFetch(jarA, 'GET', `/communities/${communityId}/channels`, null);
  if (rCh.status !== 200) throw new Error(`get channels: ${rCh.status}`);
  const channelId = (rCh.data?.channels || rCh.data || [])[0]?.id;
  if (!channelId) throw new Error('no channelId');

  const [connA, connB] = await Promise.all([connectWs(jarA), connectWs(jarB)]);


  return { jarA, connA, connB, channelId, idx };
}

// ── Run one pair sender loop ──────────────────────────────────────────────────

async function runPair(pair, stopAt) {
  const { jarA, connB, channelId, idx } = pair;
  let seq = 0;

  while (Date.now() < stopAt) {
    const t0 = Date.now();
    seq++;
    const content = `ch-${idx}-${seq}-${t0}`;

    // Pre-register waiter BEFORE sending
    const dp = waitForChannel(connB, content, DELIVERY_MS);
    dp.then(() => { stats.delivered++; stats.latencies.push(Date.now() - t0); })
      .catch(() => { stats.timeout++; });

    try {
      const r = await apiFetch(jarA, 'POST', '/messages', { channelId, content });
      if (r.status !== 200 && r.status !== 201) { stats.error++; continue; }
      stats.sent++;
    } catch { stats.error++; continue; }

    const elapsed = Date.now() - t0;
    const wait = INTERVAL_MS - elapsed;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  pair.connA.ws.close();
  pair.connB.ws.close();
}

// ── Progress printer ──────────────────────────────────────────────────────────

function printProgress(elapsed) {
  const rps = stats.sent / Math.max(elapsed, 0.1);
  const rate = stats.sent > 0 ? ((stats.delivered / stats.sent) * 100).toFixed(1) : '0.0';
  const p50 = percentile(stats.latencies, 50);
  const p99 = percentile(stats.latencies, 99);
  process.stdout.write(
    `\r  sent=${B(stats.sent)}  delivered=${G(stats.delivered)}  timeout=${stats.timeout > 0 ? R(stats.timeout) : stats.timeout}  err=${stats.error}` +
    `  rps=${rps.toFixed(0)}  rate=${rate}%  p50=${p50}ms  p99=${p99}ms   `
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nTarget: ${BASE_URL}`);
  console.log(`Config: ${PAIRS} pairs  ${TARGET_RPS} rps target  ${DURATION_S}s  timeout=${DELIVERY_MS}ms`);
  console.log(`Interval per pair: ${INTERVAL_MS.toFixed(1)}ms\n`);

  process.stdout.write(`Setting up ${PAIRS} pairs...`);
  const pairs = await Promise.all(
    Array.from({ length: PAIRS }, (_, i) =>
      setupPair(i).catch(e => { console.error(`\nPair ${i} setup failed: ${e.message}`); return null; })
    )
  );
  const live = pairs.filter(Boolean);
  console.log(` ${G(live.length)} ready\n`);
  if (!live.length) { console.error(R('No pairs. Abort.')); process.exit(1); }

  const startAt = Date.now();
  const stopAt  = startAt + DURATION_S * 1000;

  const loops  = live.map(p => runPair(p, stopAt));
  const ticker = setInterval(() => printProgress((Date.now() - startAt) / 1000), 500);

  await Promise.all(loops);
  await new Promise(r => setTimeout(r, DELIVERY_MS + 500));
  clearInterval(ticker);

  const elapsed = (Date.now() - startAt) / 1000;
  printProgress(elapsed);
  console.log('\n');

  const rate = stats.sent > 0 ? ((stats.delivered / stats.sent) * 100).toFixed(2) : '0.00';
  console.log('── Results ───────────────────────────────────────────────');
  console.log(`  Duration:    ${elapsed.toFixed(1)}s`);
  console.log(`  Sent:        ${stats.sent}`);
  console.log(`  Delivered:   ${G(stats.delivered)}  (${rate}%)`);
  console.log(`  Timeouts:    ${stats.timeout > 0 ? R(stats.timeout) : G(stats.timeout)}`);
  console.log(`  Errors:      ${stats.error > 0 ? R(stats.error) : G(stats.error)}`);
  console.log(`  Actual RPS:  ${(stats.sent / elapsed).toFixed(1)}`);
  console.log(`  p50 latency: ${percentile(stats.latencies, 50)}ms`);
  console.log(`  p95 latency: ${percentile(stats.latencies, 95)}ms`);
  console.log(`  p99 latency: ${percentile(stats.latencies, 99)}ms`);
  console.log('──────────────────────────────────────────────────────────\n');

  process.exit(stats.timeout > 0 || stats.error > stats.sent * 0.01 ? 1 : 0);
}

main().catch(e => { console.error(R('Crashed:'), e); process.exit(1); });
