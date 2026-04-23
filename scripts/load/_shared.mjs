// Shared utilities for load test scripts.

export function flag(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export class Jar {
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

export async function apiFetch(baseUrl, jar, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const c = jar.header();
  if (c) headers['Cookie'] = c;
  const res = await fetch(`${baseUrl}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  jar.absorb(res);
  let data; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

// ── Stats tracker ─────────────────────────────────────────────────────────────

export function makeStats() {
  const ops = new Map(); // label → { ok, fail, latencies, errors }

  function get(label) {
    if (!ops.has(label)) ops.set(label, { ok: 0, fail: 0, latencies: [], errors: [] });
    return ops.get(label);
  }

  return {
    record(label, ms, success, errMsg = '') {
      const o = get(label);
      if (success) { o.ok++; o.latencies.push(ms); }
      else { o.fail++; if (errMsg) o.errors.push(errMsg); }
    },
    totals() {
      let ok = 0, fail = 0;
      for (const o of ops.values()) { ok += o.ok; fail += o.fail; }
      return { ok, fail };
    },
    hasFailures() {
      for (const o of ops.values()) { if (o.fail > 0) return true; }
      return false;
    },
    ops,
  };
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p / 100)];
}

const G   = s => `\x1b[32m${s}\x1b[0m`;
const R   = s => `\x1b[31m${s}\x1b[0m`;
const Y   = s => `\x1b[33m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;

export function printProgress(label, stats) {
  const { ok, fail } = stats.totals();
  const total = ok + fail;
  const rate = total > 0 ? ((ok / total) * 100).toFixed(1) : '0.0';
  process.stdout.write(`\r[${label}] ok=${ok} fail=${fail} rate=${rate}%   `);
}

export function printSummary(label, stats) {
  const { ok, fail } = stats.totals();
  console.log(`\n[${label}] ── Summary ─────────────────────────────`);
  for (const [name, o] of stats.ops) {
    const total = o.ok + o.fail;
    const rate = total > 0 ? ((o.ok / total) * 100).toFixed(1) : 'n/a';
    const p50 = pct(o.latencies, 50);
    const p99 = pct(o.latencies, 99);
    const status = o.fail === 0 ? G('✓') : R('✗');
    console.log(`  ${status} ${name.padEnd(36)} ok=${o.ok} fail=${o.fail > 0 ? R(o.fail) : o.fail} rate=${rate}% p50=${p50}ms p99=${p99}ms`);
    if (o.errors.length) {
      const uniq = [...new Set(o.errors)].slice(0, 3);
      for (const e of uniq) console.log(`      ${DIM(e)}`);
    }
  }
  console.log(`  Total: ok=${G(ok)} fail=${fail > 0 ? R(fail) : G(fail)}`);
  console.log(`[${label}] ──────────────────────────────────────────\n`);
}
