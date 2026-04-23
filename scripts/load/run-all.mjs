/**
 * Load test orchestrator — runs all load tests in parallel, reports combined results.
 *
 * Usage:
 *   node scripts/load/run-all.mjs https://group-6.cse356.compas.cs.stonybrook.edu
 *
 * Options:
 *   --dur    15   duration per test in seconds (default 15)
 *   --quick       shorthand for --dur 10
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dir = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.argv.find(a => a.startsWith('http')) || 'http://localhost:5173';
const DUR = process.argv.includes('--quick') ? 10 : (
  (() => { const i = process.argv.indexOf('--dur'); return i >= 0 ? process.argv[i + 1] : '15'; })()
);

const G   = s => `\x1b[32m${s}\x1b[0m`;
const R   = s => `\x1b[31m${s}\x1b[0m`;
const Y   = s => `\x1b[33m${s}\x1b[0m`;
const B   = s => `\x1b[36m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;

// ── Test definitions ──────────────────────────────────────────────────────────

const TESTS = [
  {
    name: 'dm-delivery',
    script: 'dm.mjs',
    args: ['--rps', '100', '--pairs', '10', '--dur', DUR],
    description: 'DM send + WS delivery',
  },
  {
    name: 'channel-delivery',
    script: 'channel.mjs',
    args: ['--rps', '100', '--pairs', '10', '--dur', DUR],
    description: 'Channel send + WS delivery',
  },
  {
    name: 'auth',
    script: 'auth.mjs',
    args: ['--rps', '30', '--concurrency', '5', '--dur', DUR],
    description: 'Register + login throughput',
  },
  {
    name: 'rest-reads',
    script: 'rest.mjs',
    args: ['--rps', '60', '--concurrency', '8', '--dur', DUR],
    description: 'Community/channel/DM history reads',
  },
  {
    name: 'search',
    script: 'search.mjs',
    args: ['--rps', '20', '--concurrency', '4', '--dur', DUR],
    description: 'Message + community search',
  },
  {
    name: 'reconnect',
    script: 'reconnect.mjs',
    args: [],
    description: 'DM delivery after WS disconnect/reconnect',
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

function runTest(test) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dir, test.script);
    const args = [scriptPath, BASE_URL, ...test.args];
    const lines = [];
    const startMs = Date.now();

    const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', d => {
      const text = d.toString();
      // Forward prefixed output live
      text.split('\n').filter(Boolean).forEach(l => {
        process.stdout.write(`  ${DIM('[' + test.name + ']')} ${l}\n`);
        lines.push(l);
      });
    });
    child.stderr.on('data', d => {
      const text = d.toString().trim();
      if (text) process.stderr.write(`  ${R('[' + test.name + ' ERR]')} ${text}\n`);
      lines.push('[ERR] ' + text);
    });

    child.on('close', (code) => {
      resolve({
        name: test.name,
        description: test.description,
        exitCode: code,
        durationMs: Date.now() - startMs,
        passed: code === 0,
        lines,
      });
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${Y('══════════════════════════════════════════════════════')}`);
  console.log(`  Load Test Suite — All Systems`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Duration per test: ${DUR}s`);
  console.log(`  Running ${TESTS.length} tests in parallel`);
  console.log(`${Y('══════════════════════════════════════════════════════')}\n`);

  const startMs = Date.now();
  const results = await Promise.all(TESTS.map(runTest));
  const totalMs = Date.now() - startMs;

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(`\n${Y('══════════════════════════════════════════════════════')}`);
  console.log(`  Results  (wall time: ${(totalMs / 1000).toFixed(1)}s)`);
  console.log(`${Y('──────────────────────────────────────────────────────')}`);

  let passed = 0, failed = 0;
  for (const r of results) {
    const icon = r.passed ? G('✓') : R('✗');
    const dur  = `${(r.durationMs / 1000).toFixed(1)}s`;
    console.log(`  ${icon}  ${r.name.padEnd(20)} ${r.description.padEnd(34)} ${DIM(dur)}`);
    if (!r.passed) {
      // Print last few lines of output for context
      const relevant = r.lines.filter(l => l.includes('fail') || l.includes('ERR') || l.includes('✗') || l.includes('crash')).slice(-5);
      for (const l of relevant) console.log(`       ${R('→')} ${DIM(l.trim())}`);
    }
    r.passed ? passed++ : failed++;
  }

  console.log(`${Y('──────────────────────────────────────────────────────')}`);
  console.log(`  ${G(passed + ' passed')}  ${failed > 0 ? R(failed + ' failed') : G('0 failed')}\n`);

  if (failed > 0) {
    console.log(`  ${R('Pain points:')}`);
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    ${R('→')} ${r.name}: ${r.description}`);
    }
    console.log('');
  }

  console.log(`${Y('══════════════════════════════════════════════════════')}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(R('Orchestrator crashed:'), e.message); process.exit(1); });
