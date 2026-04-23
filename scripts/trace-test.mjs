/**
 * End-to-end delivery tracer with auto-SSH log fetching.
 *
 * Usage:
 *   node scripts/trace-test.mjs https://group-6.cse356.compas.cs.stonybrook.edu [--key /path/to/id_rsa]
 *
 * On failure: automatically SSHs into relevant VMs and greps logs.
 * Requires ws: npm install -g ws   Node 18+.
 */

import { createRequire } from 'module';
import { execSync, spawnSync } from 'child_process';
const require = createRequire(import.meta.url);
let WebSocket;
try { WebSocket = require('ws'); } catch {
  console.error('ws not found. Run: npm install -g ws');
  process.exit(1);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = (process.argv.find(a => a.startsWith('http')) || 'http://localhost:5173').replace(/\/$/, '');
const WS_URL = BASE_URL.replace(/^https?/, 'ws') + '/ws';
const SSH_KEY = (() => { const i = process.argv.indexOf('--key'); return i >= 0 ? process.argv[i + 1] : null; })();
const DELIVERY_TIMEOUT_MS = 8000;
const MAX_ROUNDS = 200;

const JUMP = '130.245.136.45'; // discord-development (jump host for private IPs)

const VMS = {
  messages:  { host: '130.245.136.231', label: 'messages-vm-1',   service: 'discord-messages',    jump: true },
  dms:       { host: '130.245.136.81',  label: 'dms-vm',          service: 'discord-dms',         jump: true },
  realtime:  { host: '130.245.136.98',  label: 'real-time-vm',    service: 'discord-realtime discord-realtime-2 discord-realtime-3 discord-realtime-4',  jump: true },
  backend:   { host: '130.245.136.45',  label: 'discord-dev',     service: 'discord-communities', jump: false },
  auth:      { host: '130.245.136.131', label: 'auth-vm-1',       service: 'discord-auth',        jump: true },
};

// ─── SSH helper ───────────────────────────────────────────────────────────────

function jumpArgs(host) {
  // Connect to discord-development using local key
  const base = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes'];
  if (SSH_KEY) base.push('-i', SSH_KEY);
  base.push(`root@${JUMP}`);
  return base;
}

function sshGrep(vm, since, until, pattern, retries = 5) {
  const unitFlags = vm.service.split(' ').map(s => `-u ${s}`).join(' ');
  const journalCmd = `journalctl ${unitFlags} --since "${since}" --until "${until}" 2>&1 | grep -E "${pattern}" | head -40`;

  const buildArgs = () => {
    const args = jumpArgs();
    if (vm.jump) {
      const innerCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes root@${vm.host} '${journalCmd.replace(/'/g, "'\\''")}'`;
      args.push(innerCmd);
    } else {
      args.push(journalCmd);
    }
    return args;
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = spawnSync('ssh', buildArgs(), { timeout: 25000, encoding: 'utf8' });
    // status 0 = success with output, status 1 = grep no matches, both are fine
    if (result.error == null && (result.status === 0 || result.status === 1)) {
      return (result.stdout || '').trim() || '(no matching log lines)';
    }
    const err = (result.stderr || result.error?.message || '').trim();
    if (attempt < retries) {
      process.stdout.write(`    retry ${attempt}/${retries - 1}...   \r`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    } else {
      return `[SSH failed after ${retries} attempts: ${err.split('\n')[0]}]`;
    }
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

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
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  jar.absorb(res);
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data, ms: Date.now() - t0 };
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connectWs(jar) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: jar.header() } });
    const listeners = [];
    ws.on('open', () => resolve({ ws, listeners }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (process.env.WS_DEBUG) console.log(`  [WS] ${JSON.stringify(msg).slice(0, 200)}`);
      for (let i = listeners.length - 1; i >= 0; i--)
        if (listeners[i](msg)) listeners.splice(i, 1);
    });
    ws.on('close', (code) => {
      for (let i = listeners.length - 1; i >= 0; i--) {
        listeners[i]({ type: '__closed__', code });
        listeners.splice(i, 1);
      }
    });
  });
}

function waitForEvent(conn, predicate, ms = DELIVERY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.listeners.splice(conn.listeners.indexOf(h), 1);
      reject(new Error(`WS delivery timeout after ${ms}ms`));
    }, ms);
    const h = (msg) => {
      if (msg.type === '__closed__') { clearTimeout(timer); reject(new Error(`WS closed code=${msg.code}`)); return true; }
      if (predicate(msg)) { clearTimeout(timer); resolve({ event: msg, ms: Date.now() }); return true; }
      return false;
    };
    conn.listeners.push(h);
  });
}

// ─── Print helpers ────────────────────────────────────────────────────────────

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

function ok(label, ms, detail = '')   { console.log(`  ${G('✓')}  ${label.padEnd(42)} ${String(ms).padStart(6)}ms  ${detail}`); }
function fail(label, ms, detail = '') { console.log(`  ${R('✗')}  ${label.padEnd(42)} ${String(ms).padStart(6)}ms  ${detail}`); }
function ts() { return new Date().toISOString(); }

// ─── Auto-SSH log fetch ───────────────────────────────────────────────────────

async function fetchLogs(kind, failIso, userAId, userBId) {
  const since = failIso.slice(0, 19).replace('T', ' ');
  const until = new Date(new Date(failIso).getTime() + 20000).toISOString().slice(0, 19).replace('T', ' ');
  const aShort = userAId.slice(0, 8);
  const bShort = userBId.slice(0, 8);

  console.log(Y(`\n━━━ AUTO-FETCHING LOGS (${kind}) ━━━`));
  console.log(`  Since: ${since} UTC  →  Until: ${until} UTC`);
  console.log(`  userA: ${userAId}   userB: ${userBId}\n`);

  const vmsToCheck = kind === 'channel'
    ? [
        { vm: VMS.messages,  pattern: `${aShort}|error|Error` },
        { vm: VMS.realtime,  pattern: `${bShort}|deliver|fanout|error|Error` },
        { vm: VMS.backend,   pattern: `${aShort}|error|Error` },
      ]
    : [
        { vm: VMS.dms,      pattern: `${aShort}|error|Error|fanout|timeout` },
        { vm: VMS.realtime, pattern: `${bShort}|deliver|fanout|error|Error` },
      ];

  for (const { vm, pattern } of vmsToCheck) {
    console.log(Y(`  ┌─ ${vm.label} (${vm.service})`));
    process.stdout.write('    fetching...\r');
    const out = sshGrep(vm, since, until, pattern);
    if (!out || out.startsWith('[SSH failed')) {
      console.log(`  │  ${out || '(no output)'}`);
    } else {
      out.split('\n').forEach(l => console.log(`  │  ${l}`));
    }
    console.log(`  └─────────────────────────────────────────────\n`);
  }

  // Also check Redis INSTANCE_REGISTRY for stale entries
  console.log(Y('  ┌─ Redis INSTANCE_REGISTRY (KV redis 10.0.3.49:6380)'));
  process.stdout.write('    fetching...\r');
  const regArgs = jumpArgs();
  regArgs.push('redis-cli -h 10.0.3.49 -p 6380 HGETALL realtime:instances');
  const regResult = spawnSync('ssh', regArgs, { timeout: 10000, encoding: 'utf8' });
  const regOut = (regResult.stdout || regResult.stderr || regResult.error?.message || '[no output]').trim();
  regOut.split('\n').forEach(l => console.log(`  │  ${l}`));
  console.log(`  └─────────────────────────────────────────────\n`);

  console.log(Y('━━━ END AUTO-FETCH ━━━\n'));
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup() {
  const uid = Date.now().toString(36);
  const jarA = new Jar(), jarB = new Jar();

  console.log(`\nTarget:  ${BASE_URL}`);
  console.log(`WS:      ${WS_URL}`);
  console.log(`Run ID:  ${uid}\n`);

  console.log('[ 1 ] Auth');
  const rA = await apiFetch(jarA, 'POST', '/auth/register', { username: `tr-a-${uid}`, password: 'TracerPass1!', displayName: `tr-a-${uid}` });
  if (rA.status !== 200 && rA.status !== 201) { fail('register A', rA.ms, `HTTP ${rA.status} ${JSON.stringify(rA.data)}`); process.exit(1); }
  const userAId = rA.data?.internal_id || rA.data?.id || rA.data?.user?.internal_id || '';
  ok('register A', rA.ms, `id=${userAId}`);

  const rB = await apiFetch(jarB, 'POST', '/auth/register', { username: `tr-b-${uid}`, password: 'TracerPass1!', displayName: `tr-b-${uid}` });
  if (rB.status !== 200 && rB.status !== 201) { fail('register B', rB.ms, `HTTP ${rB.status} ${JSON.stringify(rB.data)}`); process.exit(1); }
  const userBId = rB.data?.internal_id || rB.data?.id || rB.data?.user?.internal_id || '';
  ok('register B', rB.ms, `id=${userBId}`);

  console.log('\n[ 2 ] WebSocket');
  const connA = await connectWs(jarA).catch(e => { fail('WS A', 0, e.message); process.exit(1); });
  ok('WS connect A', 0);
  const connB = await connectWs(jarB).catch(e => { fail('WS B', 0, e.message); process.exit(1); });
  ok('WS connect B', 0);

  console.log('\n[ 3 ] Community');
  const rC = await apiFetch(jarA, 'POST', '/create-community', { name: `Tracer-${uid}` });
  if (rC.status !== 200 && rC.status !== 201) { fail('create community', rC.ms, `HTTP ${rC.status} ${JSON.stringify(rC.data)}`); process.exit(1); }
  const communityId = rC.data?.community?.id || rC.data?.id || '';
  ok('create community', rC.ms, `id=${communityId}`);

  const rJ = await apiFetch(jarB, 'POST', `/communities/${communityId}/join`, {});
  if (rJ.status !== 200 && rJ.status !== 201) { fail('B join', rJ.ms, `HTTP ${rJ.status} ${JSON.stringify(rJ.data)}`); process.exit(1); }
  ok('B join community', rJ.ms);

  const rCh = await apiFetch(jarA, 'GET', `/communities/${communityId}/channels`, null);
  if (rCh.status !== 200) { fail('get channels', rCh.ms, `HTTP ${rCh.status}`); process.exit(1); }
  const channelId = (rCh.data?.channels || rCh.data || [])[0]?.id || '';
  if (!channelId) { fail('get channels', rCh.ms, `empty: ${JSON.stringify(rCh.data)}`); process.exit(1); }
  ok('get channels', rCh.ms, `id=${channelId}`);

  console.log('\n[ 4 ] DM');
  const rD = await apiFetch(jarA, 'POST', '/dms', { type: 'one_to_one', participantIds: [userBId] });
  if (rD.status !== 200 && rD.status !== 201) { fail('create DM', rD.ms, `HTTP ${rD.status} ${JSON.stringify(rD.data)}`); process.exit(1); }
  const dmId = rD.data?.conversation?.conversationId || rD.data?.conversationId || rD.data?.id || '';
  ok('create DM', rD.ms, `id=${dmId}`);

  console.log(`\n  userA: ${userAId}`);
  console.log(`  userB: ${userBId}`);
  console.log(`  community=${communityId}  channel=${channelId}  dm=${dmId}\n`);

  return { uid, jarA, jarB, connA, connB, userAId, userBId, communityId, channelId, dmId };
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function run() {
  const ctx = await setup();
  const { jarA, connB, channelId, dmId, userAId, userBId } = ctx;

  console.log(`[ 5 ] Rounds until failure  (timeout=${DELIVERY_TIMEOUT_MS}ms  max=${MAX_ROUNDS})\n`);

  for (let i = 0; i < MAX_ROUNDS; i++) {
    // ── Channel ──────────────────────────────────────────────────────────
    {
      const round = i + 1;
      const content = `trace-ch-${ctx.uid}-${round}`;
      const t0 = Date.now();
      const failIso = ts();
      const dp = waitForEvent(connB, m => m.type === 'channel:message:create' && m.message?.content === content);

      let sendMs;
      try {
        const r = await apiFetch(jarA, 'POST', '/messages', { channelId, content });
        sendMs = Date.now() - t0;
        if (r.status !== 200 && r.status !== 201) {
          fail(`ch ${round} send`, sendMs, `HTTP ${r.status} ${JSON.stringify(r.data)}`);
          await fetchLogs('channel', failIso, userAId, userBId);
          break;
        }
        ok(`ch ${round} send`, sendMs);
      } catch (e) {
        fail(`ch ${round} send`, Date.now() - t0, e.message);
        await fetchLogs('channel', failIso, userAId, userBId);
        break;
      }

      try {
        const { ms } = await dp;
        ok(`ch ${round} WS delivery`, Date.now() - t0 - sendMs);
      } catch (e) {
        fail(`ch ${round} WS delivery`, Date.now() - t0, e.message);
        await fetchLogs('channel', failIso, userAId, userBId);
        break;
      }
    }

    // ── DM ───────────────────────────────────────────────────────────────
    if (dmId) {
      const round = i + 1;
      const content = `trace-dm-${ctx.uid}-${round}`;
      const t0 = Date.now();
      const failIso = ts();
      const dp = waitForEvent(connB, m => m.type === 'dm:message:create' && m.message?.content === content);

      let sendMs;
      try {
        const r = await apiFetch(jarA, 'POST', `/dms/${dmId}/messages`, { content });
        sendMs = Date.now() - t0;
        if (r.status !== 200 && r.status !== 201) {
          fail(`dm ${round} send`, sendMs, `HTTP ${r.status} ${JSON.stringify(r.data)}`);
          await fetchLogs('dm', failIso, userAId, userBId);
          break;
        }
        ok(`dm ${round} send`, sendMs);
      } catch (e) {
        fail(`dm ${round} send`, Date.now() - t0, e.message);
        await fetchLogs('dm', failIso, userAId, userBId);
        break;
      }

      try {
        const { ms } = await dp;
        ok(`dm ${round} WS delivery`, Date.now() - t0 - sendMs);
      } catch (e) {
        fail(`dm ${round} WS delivery`, Date.now() - t0, e.message);
        await fetchLogs('dm', failIso, userAId, userBId);
        break;
      }
    }
  }

  ctx.connA?.ws?.close?.();
  ctx.connB?.ws?.close?.();
}

run().catch(e => { console.error('Tracer crashed:', e); process.exit(1); });
