/**
 * DM load test — sustained message throughput with delivery verification.
 *
 * Usage:
 *   node scripts/dm-load-test.mjs https://group-6.cse356.compas.cs.stonybrook.edu [options]
 *
 * Options:
 *   --rps   200        target messages per second (default 200)
 *   --pairs 20         concurrent sender/receiver pairs (default 20)
 *   --dur   30         test duration in seconds (default 30)
 *   --timeout 5000     delivery timeout per message ms (default 5000)
 *   --key   /path/key  SSH key (unused here, kept for compat)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let WebSocket;
try { WebSocket = require('ws'); } catch {
  console.error('ws not found. Run: npm install -g ws');
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = (process.argv.find(a => a.startsWith('http')) || 'http://localhost:5173').replace(/\/$/, '');
const WS_URL   = BASE_URL.replace(/^https?/, 'ws') + '/ws';

function flag(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (isNaN(Number(process.argv[i+1])) ? process.argv[i+1] : Number(process.argv[i+1])) : def;
}
const TARGET_RPS     = flag('--rps',     200);
const PAIRS          = flag('--pairs',    20);
const DURATION_S     = flag('--dur',      15);
const DELIVERY_MS    = flag('--timeout', 5000);

const INTERVAL_MS    = 1000 / (TARGET_RPS / PAIRS); // ms between sends per pair

// ── Helpers ───────────────────────────────────────────────────────────────────

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[36m${s}\x1b[0m`;

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
    const pending = new Map(); // messageId -> { resolve, reject, timer }
    ws.on('open', () => resolve({ ws, pending }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'dm:message:create' && msg.message?.content) {
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

// Key by content (unique per send), registered BEFORE the HTTP send so the
// WS event can't arrive and be dropped before the listener exists.
function waitForDmByContent(conn, content, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(content);
      reject(new Error('timeout'));
    }, ms);
    conn.pending.set(content, { resolve, reject, timer });
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

const stats = { sent: 0, delivered: 0, timeout: 0, error: 0, latencies: [] };

function recordLatency(ms) { stats.latencies.push(ms); }

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p / 100)];
}

// ── Setup one pair ────────────────────────────────────────────────────────────

async function setupPair(idx) {
  const uid = `ld-${Date.now().toString(36)}-${idx}`;
  const jarA = new Jar(), jarB = new Jar();

  const rA = await apiFetch(jarA, 'POST', '/auth/register', { username: `${uid}-a`, password: 'Load1234!', displayName: `${uid}-a` });
  if (rA.status !== 200 && rA.status !== 201) throw new Error(`register A: ${rA.status}`);

  const rB = await apiFetch(jarB, 'POST', '/auth/register', { username: `${uid}-b`, password: 'Load1234!', displayName: `${uid}-b` });
  if (rB.status !== 200 && rB.status !== 201) throw new Error(`register B: ${rB.status}`);

  const userBId = rB.data?.internal_id || rB.data?.id || rB.data?.user?.internal_id;

  const rD = await apiFetch(jarA, 'POST', '/dms', { type: 'one_to_one', participantIds: [userBId] });
  if (rD.status !== 200 && rD.status !== 201) throw new Error(`create DM: ${rD.status}`);
  const dmId = rD.data?.conversation?.conversationId || rD.data?.conversationId || rD.data?.id;
  if (!dmId) throw new Error('no dmId');

  const [connA, connB] = await Promise.all([connectWs(jarA), connectWs(jarB)]);

  return { jarA, connA, connB, dmId, idx };
}

// ── Run one pair sender loop ──────────────────────────────────────────────────

async function runPair(pair, stopAt) {
  const { jarA, connA, connB, dmId, idx } = pair;
  let seq = 0;

  while (Date.now() < stopAt) {
    const t0 = Date.now();
    seq++;
    const content = `ld-${idx}-${seq}-${t0}`;

    // Pre-register waiter by content BEFORE sending so the WS event
    // can't arrive and be dropped before the listener exists.
    const dp = waitForDmByContent(connB, content, DELIVERY_MS);
    dp.then(() => { stats.delivered++; recordLatency(Date.now() - t0); })
      .catch(() => { stats.timeout++; });

    try {
      const r = await apiFetch(jarA, 'POST', `/dms/${dmId}/messages`, { content });
      if (r.status !== 200 && r.status !== 201) { stats.error++; continue; }
      stats.sent++;
    } catch { stats.error++; continue; }

    // Rate limit: sleep until next slot
    const elapsed = Date.now() - t0;
    const wait = INTERVAL_MS - elapsed;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  pair.connA.ws.close();
  pair.connB.ws.close();
}

// ── Progress printer ──────────────────────────────────────────────────────────

function printProgress(elapsed) {
  const rps = stats.sent / elapsed;
  const delivRate = stats.sent > 0 ? ((stats.delivered / stats.sent) * 100).toFixed(1) : '0.0';
  const p50 = percentile(stats.latencies, 50);
  const p99 = percentile(stats.latencies, 99);
  process.stdout.write(
    `\r  sent=${B(stats.sent)}  delivered=${G(stats.delivered)}  timeout=${stats.timeout > 0 ? R(stats.timeout) : stats.timeout}  err=${stats.error}` +
    `  rps=${rps.toFixed(0)}  rate=${delivRate}%  p50=${p50}ms  p99=${p99}ms   `
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nTarget: ${BASE_URL}`);
  console.log(`Config: ${PAIRS} pairs  ${TARGET_RPS} rps target  ${DURATION_S}s  timeout=${DELIVERY_MS}ms`);
  console.log(`Interval per pair: ${INTERVAL_MS.toFixed(1)}ms\n`);

  // Setup all pairs concurrently
  process.stdout.write(`Setting up ${PAIRS} pairs...`);
  const pairs = await Promise.all(
    Array.from({ length: PAIRS }, (_, i) => setupPair(i).catch(e => { console.error(`\nPair ${i} setup failed: ${e.message}`); return null; }))
  );
  const livePairs = pairs.filter(Boolean);
  console.log(` ${G(livePairs.length)} ready\n`);

  if (livePairs.length === 0) { console.error(R('No pairs set up. Abort.')); process.exit(1); }

  const startAt = Date.now();
  const stopAt  = startAt + DURATION_S * 1000;

  // Start all pair loops
  const loops = livePairs.map(p => runPair(p, stopAt));

  // Progress ticker
  const ticker = setInterval(() => printProgress((Date.now() - startAt) / 1000), 500);

  await Promise.all(loops);
  // Drain pending deliveries (up to DELIVERY_MS extra)
  await new Promise(r => setTimeout(r, DELIVERY_MS + 500));
  clearInterval(ticker);

  const elapsed = (Date.now() - startAt) / 1000;
  printProgress(elapsed);
  console.log('\n');

  // Final report
  const delivRate = stats.sent > 0 ? ((stats.delivered / stats.sent) * 100).toFixed(2) : '0.00';
  console.log('── Results ───────────────────────────────────────────────');
  console.log(`  Duration:    ${elapsed.toFixed(1)}s`);
  console.log(`  Sent:        ${stats.sent}`);
  console.log(`  Delivered:   ${G(stats.delivered)}  (${delivRate}%)`);
  console.log(`  Timeouts:    ${stats.timeout > 0 ? R(stats.timeout) : G(stats.timeout)}`);
  console.log(`  Errors:      ${stats.error > 0 ? R(stats.error) : G(stats.error)}`);
  console.log(`  Actual RPS:  ${(stats.sent / elapsed).toFixed(1)}`);
  console.log(`  p50 latency: ${percentile(stats.latencies, 50)}ms`);
  console.log(`  p95 latency: ${percentile(stats.latencies, 95)}ms`);
  console.log(`  p99 latency: ${percentile(stats.latencies, 99)}ms`);
  console.log('──────────────────────────────────────────────────────────\n');

  process.exit(stats.timeout > 0 || stats.error > (stats.sent * 0.01) ? 1 : 0);
}

main().catch(e => { console.error(R('Crashed:'), e); process.exit(1); });
