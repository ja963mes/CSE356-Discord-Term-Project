/**
 * Reconnect delivery test — sends DMs while recipient is disconnected,
 * verifies dm:message:create arrives after reconnect.
 *
 * This catches the bug where the reconnect path (pending queue drain +
 * Cassandra replay) sends dm:new_message hints instead of dm:message:create,
 * causing grader delivery timeouts after any WS disconnect.
 *
 * Usage: node scripts/load/reconnect.mjs https://...
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let WebSocket;
try { WebSocket = require('ws'); } catch { console.error('npm install -g ws'); process.exit(1); }

const BASE_URL   = (process.argv.find(a => a.startsWith('http')) || 'http://localhost:5173').replace(/\/$/, '');
const WS_URL     = BASE_URL.replace(/^https?/, 'ws') + '/ws';
const ROUNDS     = 10;
const DELIVER_MS = 8000;

const G   = s => `\x1b[32m${s}\x1b[0m`;
const R   = s => `\x1b[31m${s}\x1b[0m`;
const Y   = s => `\x1b[33m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;

let passed = 0, failed = 0;
const failures = [];

function ok(label, detail = '')   { passed++; console.log(`  ${G('✓')}  ${label.padEnd(55)} ${DIM(detail)}`); }
function fail(label, detail = '') { failed++; failures.push({ label, detail }); console.log(`  ${R('✗')}  ${label.padEnd(55)} ${R(detail)}`); }

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
  header() { return [...this.cookies.entries()].map(([k,v]) => `${k}=${v}`).join('; '); }
}

async function apiFetch(jar, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const c = jar.header(); if (c) headers['Cookie'] = c;
  const res = await fetch(`${BASE_URL}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  jar.absorb(res);
  let data; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function connectWs(jar) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: jar.header() } });
    const pending = new Map();
    let ready = false;
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!ready && msg.type === 'presence_update') { ready = true; resolve({ ws, pending }); }
      // Match dm:message:create by content
      if (msg.type === 'dm:message:create' && msg.message?.content) {
        const p = pending.get(msg.message.content);
        if (p) { clearTimeout(p.timer); p.resolve(msg); pending.delete(msg.message.content); }
      }
      // Match dm:new_message by messageId (to detect wrong event type)
      if (msg.type === 'dm:new_message' && msg.messageId) {
        const p = pending.get(`hint:${msg.messageId}`);
        if (p) { clearTimeout(p.timer); p.resolve(msg); pending.delete(`hint:${msg.messageId}`); }
      }
    });
    ws.on('error', reject);
    ws.on('close', () => {
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('WS closed')); }
      pending.clear();
    });
    setTimeout(() => { if (!ready) { ready = true; resolve({ ws, pending }); } }, 3000);
  });
}

function waitForContent(conn, content, ms = DELIVER_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { conn.pending.delete(content); reject(new Error('timeout')); }, ms);
    conn.pending.set(content, { resolve, reject, timer });
  });
}

async function main() {
  console.log(`\n${Y('══════════════════════════════════════════════════════')}`);
  console.log(`  Reconnect Delivery Test`);
  console.log(`  Target: ${BASE_URL}  Rounds: ${ROUNDS}`);
  console.log(`${Y('══════════════════════════════════════════════════════')}\n`);

  // Setup
  const jarA = new Jar(), jarB = new Jar();
  const uid = Date.now().toString(36);

  const rA = await apiFetch(jarA, 'POST', '/auth/register', { username: `rc-a-${uid}`, password: 'Test1234!', displayName: `rc-a-${uid}` });
  const rB = await apiFetch(jarB, 'POST', '/auth/register', { username: `rc-b-${uid}`, password: 'Test1234!', displayName: `rc-b-${uid}` });
  const userBId = rB.data?.internal_id || rB.data?.id || rB.data?.user?.internal_id;
  if (rA.status !== 200 && rA.status !== 201) { console.error('register A failed'); process.exit(1); }
  if (rB.status !== 200 && rB.status !== 201) { console.error('register B failed'); process.exit(1); }

  const rDM = await apiFetch(jarA, 'POST', '/dms', { type: 'one_to_one', participantIds: [userBId] });
  const dmId = rDM.data?.conversation?.conversationId || rDM.data?.conversationId || rDM.data?.id;
  if (!dmId) { console.error('create DM failed'); process.exit(1); }

  console.log(`  Setup: dmId=${dmId}\n`);

  // ── Test 1: Baseline — both connected, live delivery ──────────────────────
  console.log(Y('[ 1 ] Baseline — both connected (live delivery)'));
  {
    const connA = await connectWs(jarA);
    const connB = await connectWs(jarB);

    for (let i = 1; i <= 3; i++) {
      const content = `live-${uid}-${i}`;
      const dp = waitForContent(connB, content);
      await apiFetch(jarA, 'POST', `/dms/${dmId}/messages`, { content });
      try { await dp; ok(`live round ${i} dm:message:create delivered`); }
      catch (e) { fail(`live round ${i} dm:message:create delivered`, e.message); }
    }

    connA.ws.close();
    connB.ws.close();
    await new Promise(r => setTimeout(r, 500));
  }

  // ── Test 2: Disconnect B, send messages, reconnect B ─────────────────────
  console.log(Y('\n[ 2 ] Disconnect → send → reconnect'));
  for (let round = 1; round <= ROUNDS; round++) {
    // Connect A only (B offline)
    const connA = await connectWs(jarA);

    const content = `recon-${uid}-${round}`;
    const r = await apiFetch(jarA, 'POST', `/dms/${dmId}/messages`, { content });
    const msgId = r.data?.message?.messageId;
    if (r.status !== 200 && r.status !== 201) {
      fail(`round ${round} send`, `HTTP ${r.status}`);
      connA.ws.close();
      continue;
    }

    // Give server time to enqueue pending hint
    await new Promise(r => setTimeout(r, 200));

    // Reconnect B — should receive dm:message:create
    const connB = await connectWs(jarB);
    const dp = waitForContent(connB, content);

    try {
      const ev = await dp;
      if (ev.type === 'dm:message:create') {
        ok(`round ${round} reconnect delivery`, `dm:message:create ✓`);
      } else {
        fail(`round ${round} reconnect delivery`, `got ${ev.type} not dm:message:create`);
      }
    } catch (e) {
      // Check if we got dm:new_message hint instead (the known bug)
      fail(`round ${round} reconnect delivery`, `timeout — reconnect path likely sent dm:new_message instead of dm:message:create`);
    }

    connA.ws.close();
    connB.ws.close();
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Test 3: Send multiple messages while offline, reconnect once ──────────
  console.log(Y('\n[ 3 ] Multiple messages offline → single reconnect'));
  {
    const connA = await connectWs(jarA);
    const contents = Array.from({ length: 5 }, (_, i) => `multi-${uid}-${i}`);

    for (const content of contents) {
      await apiFetch(jarA, 'POST', `/dms/${dmId}/messages`, { content });
    }
    await new Promise(r => setTimeout(r, 500));

    const connB = await connectWs(jarB);
    for (const content of contents) {
      const dp = waitForContent(connB, content, DELIVER_MS);
      try {
        const ev = await dp;
        ok(`multi-offline msg "${content.slice(-6)}" delivered`, ev.type);
      } catch {
        fail(`multi-offline msg "${content.slice(-6)}" delivered`, `not received as dm:message:create`);
      }
    }

    connA.ws.close();
    connB.ws.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${Y('══════════════════════════════════════════════════════')}`);
  console.log(`  ${G(passed + ' passed')}  ${failed > 0 ? R(failed + ' failed') : G('0 failed')}  (${passed + failed} total)`);
  if (failures.length) {
    console.log(`\n  ${R('Failures:')}`);
    for (const f of failures) console.log(`    ${R('✗')} ${f.label}  ${DIM(f.detail)}`);
  }
  console.log(`${Y('══════════════════════════════════════════════════════')}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(R('Crashed:'), e); process.exit(1); });
