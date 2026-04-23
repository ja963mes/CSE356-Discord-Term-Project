/**
 * Full API test suite.
 *
 * Usage:
 *   node scripts/api-test.mjs https://group-6.cse356.compas.cs.stonybrook.edu
 *
 * Requires: npm install -g ws
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
const WS_TIMEOUT = 8000;

const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;

// ── State ─────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function ok(label, detail = '') {
  passed++;
  console.log(`  ${G('✓')}  ${label.padEnd(52)} ${DIM(detail)}`);
}
function fail(label, detail = '') {
  failed++;
  failures.push({ label, detail });
  console.log(`  ${R('✗')}  ${label.padEnd(52)} ${R(detail)}`);
}
function section(name) {
  console.log(`\n${Y('━━')} ${name} ${Y('━'.repeat(Math.max(0, 54 - name.length)))}`);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

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
  has(name) { return this.cookies.has(name); }
}

async function req(jar, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const c = jar.header();
  if (c) headers['Cookie'] = c;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    jar.absorb(res);
    let data; try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: null, error: e.message };
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWs(jar) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: jar.header() } });
    const pending = new Map(); // key → { resolve, reject, timer }
    ws.on('open', () => resolve({ ws, pending }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      // Match by content for channel/dm messages
      const content = msg.message?.content;
      if (content && pending.has(content)) {
        const p = pending.get(content);
        clearTimeout(p.timer);
        p.resolve(msg);
        pending.delete(content);
      }
      // Match by arbitrary key predicate
      for (const [key, p] of pending) {
        if (typeof p.predicate === 'function' && p.predicate(msg)) {
          clearTimeout(p.timer);
          p.resolve(msg);
          pending.delete(key);
        }
      }
    });
    ws.on('close', () => {
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('WS closed')); }
      pending.clear();
    });
  });
}

function waitWs(conn, keyOrPredicate, ms = WS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const key = typeof keyOrPredicate === 'string' ? keyOrPredicate : `pred_${Math.random()}`;
    const timer = setTimeout(() => { conn.pending.delete(key); reject(new Error(`WS timeout (${key})`)); }, ms);
    const entry = { resolve, reject, timer };
    if (typeof keyOrPredicate === 'function') entry.predicate = keyOrPredicate;
    conn.pending.set(key, entry);
  });
}

function closeWs(...conns) {
  for (const c of conns) { try { c?.ws?.close(); } catch {} }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function assert(label, condition, detail = '') {
  if (condition) ok(label, detail);
  else fail(label, detail);
  return condition;
}

// Register + return userId
async function register(jar, suffix) {
  const username = `t-${uid()}-${suffix}`;
  const r = await req(jar, 'POST', '/auth/register', { username, password: 'Test1234!', displayName: username });
  const id = r.data?.internal_id || r.data?.id || r.data?.user?.internal_id || '';
  return { username, id, status: r.status, data: r.data };
}

// ── Test Sections ─────────────────────────────────────────────────────────────

async function testAuth() {
  section('Auth');
  const jar = new Jar();
  const username = `t-${uid()}`;

  // Register
  const rReg = await req(jar, 'POST', '/auth/register', { username, password: 'Test1234!', displayName: 'Test User' });
  if (!assert('register returns 200/201', rReg.status === 200 || rReg.status === 201, `HTTP ${rReg.status}`)) return;
  const userId = rReg.data?.internal_id || rReg.data?.id || rReg.data?.user?.internal_id || '';
  assert('register returns userId', !!userId, userId);
  assert('session cookie set', jar.has('session_token'), '');

  // Me
  const rMe = await req(jar, 'GET', '/auth/me', null);
  assert('GET /auth/me returns 200', rMe.status === 200, `HTTP ${rMe.status}`);
  assert('GET /auth/me has username', rMe.data?.username === username || rMe.data?.user?.username === username, rMe.data?.username);

  // Update profile
  const newDisplay = `display-${uid()}`;
  const rPatch = await req(jar, 'PATCH', '/auth/profile', { displayName: newDisplay });
  assert('PATCH /auth/profile returns 200', rPatch.status === 200, `HTTP ${rPatch.status}`);

  // Verify display name updated
  const rMe2 = await req(jar, 'GET', '/auth/me', null);
  const gotDisplay = rMe2.data?.profile?.displayName || rMe2.data?.displayName || rMe2.data?.user?.profile?.displayName || '';
  assert('displayName updated', gotDisplay === newDisplay, gotDisplay);

  // Logout
  const rOut = await req(jar, 'POST', '/auth/logout', null);
  assert('POST /auth/logout returns 200/204', rOut.status === 200 || rOut.status === 204, `HTTP ${rOut.status}`);

  // After logout, /auth/me should 401
  const rMe3 = await req(jar, 'GET', '/auth/me', null);
  assert('GET /auth/me after logout returns 401', rMe3.status === 401, `HTTP ${rMe3.status}`);

  // Login
  const jar2 = new Jar();
  const rLogin = await req(jar2, 'POST', '/auth/login', { username, password: 'Test1234!' });
  assert('POST /auth/login returns 200', rLogin.status === 200, `HTTP ${rLogin.status}`);
  assert('login sets session cookie', jar2.has('session_token'), '');

  // Wrong password
  const jar3 = new Jar();
  const rBad = await req(jar3, 'POST', '/auth/login', { username, password: 'wrongpassword' });
  assert('login with wrong password returns 401', rBad.status === 401, `HTTP ${rBad.status}`);
}

async function testCommunities() {
  section('Communities');
  const jarA = new Jar(), jarB = new Jar();
  const a = await register(jarA, 'a');
  const b = await register(jarB, 'b');
  assert('setup: register A', a.status === 200 || a.status === 201, `HTTP ${a.status}`);
  assert('setup: register B', b.status === 200 || b.status === 201, `HTTP ${b.status}`);

  // Create community
  const rC = await req(jarA, 'POST', '/create-community', { name: `Test-${uid()}` });
  assert('POST /create-community returns 200/201', rC.status === 200 || rC.status === 201, `HTTP ${rC.status}`);
  const communityId = rC.data?.community?.id || rC.data?.id;
  assert('create-community returns id', !!communityId, communityId);

  // List communities (A should see it)
  const rList = await req(jarA, 'GET', '/communities', null);
  assert('GET /communities returns 200', rList.status === 200, `HTTP ${rList.status}`);
  const comms = Array.isArray(rList.data) ? rList.data : (rList.data?.communities || []);
  assert('community appears in list', comms.some(c => c.id === communityId), `found ${comms.length}`);

  // Join as B
  const rJoin = await req(jarB, 'POST', `/communities/${communityId}/join`, {});
  assert('POST /communities/:id/join returns 200/201', rJoin.status === 200 || rJoin.status === 201, `HTTP ${rJoin.status}`);

  // Members list includes B
  const rMembers = await req(jarA, 'GET', `/communities/${communityId}/members`, null);
  assert('GET /communities/:id/members returns 200', rMembers.status === 200, `HTTP ${rMembers.status}`);
  const members = Array.isArray(rMembers.data) ? rMembers.data : (rMembers.data?.members || []);
  const bId = b.id;
  assert('B appears in members list', members.some(m => (m.user_id || m.internal_id || m.id) === bId), `found ${members.length} members`);

  // Leave as B
  const rLeave = await req(jarB, 'POST', `/communities/${communityId}/leave`, {});
  assert('POST /communities/:id/leave returns 200/204', rLeave.status === 200 || rLeave.status === 204, `HTTP ${rLeave.status}`);

  // Members should no longer include B
  const rMembers2 = await req(jarA, 'GET', `/communities/${communityId}/members`, null);
  const members2 = Array.isArray(rMembers2.data) ? rMembers2.data : (rMembers2.data?.members || []);
  assert('B removed from members after leave', !members2.some(m => (m.user_id || m.internal_id || m.id) === bId), `found ${members2.length} members`);
}

async function testChannels() {
  section('Channels');
  const jarA = new Jar();
  await register(jarA, 'a');

  const rC = await req(jarA, 'POST', '/create-community', { name: `TestCh-${uid()}` });
  const communityId = rC.data?.community?.id || rC.data?.id;
  if (!assert('setup: community created', !!communityId, `HTTP ${rC.status}`)) return;

  // Get default #general channel
  const rCh = await req(jarA, 'GET', `/communities/${communityId}/channels`, null);
  assert('GET /communities/:id/channels returns 200', rCh.status === 200, `HTTP ${rCh.status}`);
  const channels = Array.isArray(rCh.data) ? rCh.data : (rCh.data?.channels || []);
  assert('#general channel seeded', channels.length >= 1, `found ${channels.length}`);
  assert('#general is public', channels[0]?.is_private === false || channels[0]?.isPrivate === false, '');

  // Create a new channel
  const rNew = await req(jarA, 'POST', `/communities/${communityId}/channels`, { name: 'test-channel', is_private: false });
  assert('POST /communities/:id/channels returns 200/201', rNew.status === 200 || rNew.status === 201, `HTTP ${rNew.status}`);
  const newChannelId = rNew.data?.channel?.id || rNew.data?.id;
  assert('new channel has id', !!newChannelId, newChannelId);

  // Create private channel
  const rPriv = await req(jarA, 'POST', `/communities/${communityId}/channels`, { name: 'secret', is_private: true });
  assert('POST private channel returns 200/201', rPriv.status === 200 || rPriv.status === 201, `HTTP ${rPriv.status}`);
  const privId = rPriv.data?.channel?.id || rPriv.data?.id;

  // List shows 3 channels
  const rCh2 = await req(jarA, 'GET', `/communities/${communityId}/channels`, null);
  const channels2 = Array.isArray(rCh2.data) ? rCh2.data : (rCh2.data?.channels || []);
  assert('channel list shows all 3', channels2.length >= 3, `found ${channels2.length}`);
  assert('private channel in list (owner sees all)', channels2.some(c => c.id === privId), '');
}

async function testChannelMessages() {
  section('Channel Messages + WS Delivery');
  const jarA = new Jar(), jarB = new Jar();
  const a = await register(jarA, 'a');
  const b = await register(jarB, 'b');

  const rC = await req(jarA, 'POST', '/create-community', { name: `TestMsg-${uid()}` });
  const communityId = rC.data?.community?.id || rC.data?.id;
  await req(jarB, 'POST', `/communities/${communityId}/join`, {});
  const rCh = await req(jarA, 'GET', `/communities/${communityId}/channels`, null);
  const channels = Array.isArray(rCh.data) ? rCh.data : (rCh.data?.channels || []);
  const channelId = channels[0]?.id;
  if (!assert('setup: channelId', !!channelId, channelId)) return;

  // Send message
  const content1 = `msg-${uid()}`;
  const rSend = await req(jarA, 'POST', '/messages', { channelId, content: content1 });
  assert('POST /messages returns 200/201', rSend.status === 200 || rSend.status === 201, `HTTP ${rSend.status}`);
  const msgId = rSend.data?.message?.messageId || rSend.data?.messageId;
  const timeuuid = rSend.data?.message?.timeuuid || rSend.data?.timeuuid;
  assert('send returns messageId', !!msgId, msgId);

  // Get messages
  const rGet = await req(jarA, 'GET', `/messages?channelId=${channelId}`, null);
  assert('GET /messages returns 200', rGet.status === 200, `HTTP ${rGet.status}`);
  const msgs = rGet.data?.messages || (Array.isArray(rGet.data) ? rGet.data : []);
  assert('message appears in history', msgs.some(m => m.messageId === msgId || m.timeuuid === timeuuid), `found ${msgs.length}`);

  // WS delivery
  const connA = await connectWs(jarA).catch(() => null);
  const connB = await connectWs(jarB).catch(() => null);
  if (!connA || !connB) { fail('WS connect for channel delivery', 'connect failed'); return; }
  await new Promise(r => setTimeout(r, 300)); // let subscription sets populate

  const content2 = `ws-${uid()}`;
  const dp = waitWs(connB, content2);
  await req(jarA, 'POST', '/messages', { channelId, content: content2 });
  try {
    const ev = await dp;
    assert('channel:message:create delivered via WS', ev.type === 'channel:message:create', ev.type);
    assert('WS event has correct content', ev.message?.content === content2, ev.message?.content);
    assert('WS event has channelId', ev.channelId === channelId || ev.message?.channelId === channelId, ev.channelId);
  } catch (e) {
    fail('channel WS delivery', e.message);
  }

  // Edit message
  if (timeuuid) {
    const rEdit = await req(jarA, 'PATCH', `/messages/${channelId}/${timeuuid}`, { content: 'edited content' });
    assert('PATCH /messages/:channelId/:timeuuid returns 200', rEdit.status === 200, `HTTP ${rEdit.status}`);
  } else {
    fail('skip edit (no timeuuid)', '');
  }

  // Delete message
  if (timeuuid) {
    const rDel = await req(jarA, 'DELETE', `/messages/${channelId}/${timeuuid}`, null);
    assert('DELETE /messages/:channelId/:timeuuid returns 200/204', rDel.status === 200 || rDel.status === 204, `HTTP ${rDel.status}`);
  } else {
    fail('skip delete (no timeuuid)', '');
  }

  closeWs(connA, connB);
}

async function testDMs() {
  section('Direct Messages + WS Delivery');
  const jarA = new Jar(), jarB = new Jar(), jarC = new Jar();
  const a = await register(jarA, 'a');
  const b = await register(jarB, 'b');
  const c = await register(jarC, 'c');
  if (!assert('setup: register A/B/C', [a, b, c].every(u => u.status === 200 || u.status === 201), '')) return;

  // Create 1:1 DM
  const rDM = await req(jarA, 'POST', '/dms', { type: 'one_to_one', participantIds: [b.id] });
  assert('POST /dms (1:1) returns 200/201', rDM.status === 200 || rDM.status === 201, `HTTP ${rDM.status}`);
  const dmId = rDM.data?.conversation?.conversationId || rDM.data?.conversationId || rDM.data?.id;
  assert('DM has conversationId', !!dmId, dmId);

  // Idempotent — creating same DM again should return existing or 200/201
  const rDM2 = await req(jarA, 'POST', '/dms', { type: 'one_to_one', participantIds: [b.id] });
  assert('POST /dms idempotent returns 200/201', rDM2.status === 200 || rDM2.status === 201, `HTTP ${rDM2.status}`);

  // List DMs
  const rList = await req(jarA, 'GET', '/dms', null);
  assert('GET /dms returns 200', rList.status === 200, `HTTP ${rList.status}`);
  const convs = Array.isArray(rList.data) ? rList.data : (rList.data?.conversations || []);
  assert('DM appears in list', convs.some(c => (c.conversationId || c.id) === dmId), `found ${convs.length}`);

  // Send DM
  const content1 = `dm-${uid()}`;
  const rSend = await req(jarA, 'POST', `/dms/${dmId}/messages`, { content: content1 });
  assert('POST /dms/:id/messages returns 200/201', rSend.status === 200 || rSend.status === 201, `HTTP ${rSend.status}`);
  const dmMsgId = rSend.data?.message?.messageId || rSend.data?.messageId;
  const dmTimeuuid = rSend.data?.message?.timeuuid || rSend.data?.timeuuid;
  assert('send DM returns messageId', !!dmMsgId, dmMsgId);

  // Get DM history
  const rGet = await req(jarB, 'GET', `/dms/${dmId}/messages`, null);
  assert('GET /dms/:id/messages returns 200', rGet.status === 200, `HTTP ${rGet.status}`);
  const msgs = rGet.data?.messages || (Array.isArray(rGet.data) ? rGet.data : []);
  assert('message appears in DM history', msgs.some(m => m.messageId === dmMsgId || m.timeuuid === dmTimeuuid), `found ${msgs.length}`);

  // WS delivery
  const connA = await connectWs(jarA).catch(() => null);
  const connB = await connectWs(jarB).catch(() => null);
  if (!connA || !connB) { fail('WS connect for DM delivery', 'connect failed'); closeWs(connA, connB); return; }
  await new Promise(r => setTimeout(r, 300));

  const content2 = `dm-ws-${uid()}`;
  const dp = waitWs(connB, content2);
  await req(jarA, 'POST', `/dms/${dmId}/messages`, { content: content2 });
  try {
    const ev = await dp;
    assert('dm:message:create delivered via WS', ev.type === 'dm:message:create', ev.type);
    assert('WS event has correct content', ev.message?.content === content2, ev.message?.content);
    assert('WS event has conversationId', ev.conversationId === dmId, ev.conversationId);
    assert('WS event has message.authorId', !!ev.message?.authorId, ev.message?.authorId);
  } catch (e) {
    fail('DM WS delivery', e.message);
  }

  // Edit DM message
  if (dmTimeuuid) {
    const rEdit = await req(jarA, 'PATCH', `/dms/${dmId}/messages/${dmTimeuuid}`, { content: 'edited dm', timeuuid: dmTimeuuid });
    assert('PATCH /dms/:id/messages/:id returns 200', rEdit.status === 200, `HTTP ${rEdit.status}`);
  } else {
    fail('skip DM edit (no timeuuid)', '');
  }

  // Delete DM message
  if (dmTimeuuid) {
    const rDel = await req(jarA, 'DELETE', `/dms/${dmId}/messages/${dmTimeuuid}?timeuuid=${encodeURIComponent(dmTimeuuid)}`, null);
    assert('DELETE /dms/:id/messages/:id returns 200/204', rDel.status === 200 || rDel.status === 204, `HTTP ${rDel.status}`);
  } else {
    fail('skip DM delete (no timeuuid)', '');
  }

  // Group DM — create with A, B, C
  const rGroup = await req(jarA, 'POST', '/dms', { type: 'group', participantIds: [b.id, c.id] });
  assert('POST /dms (group) returns 200/201', rGroup.status === 200 || rGroup.status === 201, `HTTP ${rGroup.status}`);
  const groupId = rGroup.data?.conversation?.conversationId || rGroup.data?.conversationId || rGroup.data?.id;
  assert('group DM has conversationId', !!groupId, groupId);

  // Add participant to group DM
  const jarD = new Jar();
  const d = await register(jarD, 'd');
  const rAdd = await req(jarA, 'POST', `/dms/${groupId}/participants`, { userId: d.id });
  assert('POST /dms/:id/participants returns 2xx', rAdd.status >= 200 && rAdd.status < 300, `HTTP ${rAdd.status}`);

  // Leave DM
  const rLeave = await req(jarB, 'DELETE', `/dms/${groupId}/participants/me`, null);
  assert('DELETE /dms/:id/participants/me returns 200/204', rLeave.status === 200 || rLeave.status === 204, `HTTP ${rLeave.status}`);

  closeWs(connA, connB);
}

async function testReadState() {
  section('Read State');
  const jarA = new Jar(), jarB = new Jar();
  const a = await register(jarA, 'a');
  const b = await register(jarB, 'b');

  const rDM = await req(jarA, 'POST', '/dms', { type: 'one_to_one', participantIds: [b.id] });
  const dmId = rDM.data?.conversation?.conversationId || rDM.data?.conversationId || rDM.data?.id;
  if (!assert('setup: DM created', !!dmId, `HTTP ${rDM.status}`)) return;

  // Send a message
  const rSend = await req(jarA, 'POST', `/dms/${dmId}/messages`, { content: `rs-${uid()}` });
  const msgId = rSend.data?.message?.messageId || rSend.data?.messageId;
  const timeuuid = rSend.data?.message?.timeuuid || rSend.data?.timeuuid;
  if (!assert('setup: message sent', !!msgId, `HTTP ${rSend.status}`)) return;

  // Get unread counts
  const rUnread = await req(jarB, 'GET', '/read-state/dms', null);
  assert('GET /read-state/dms returns 200', rUnread.status === 200, `HTTP ${rUnread.status}`);

  // Mark as read
  const rMark = await req(jarB, 'POST', `/read-state/dms/${dmId}/read`, { messageId: msgId, timeuuid: timeuuid || msgId });
  assert('POST /read-state/dms/:id/read returns 200/204', rMark.status === 200 || rMark.status === 204, `HTTP ${rMark.status}`);
}

async function testSearch() {
  section('Search');
  const jarA = new Jar(), jarB = new Jar();
  const a = await register(jarA, 'a');
  const b = await register(jarB, 'b');

  // Community + channel message search
  const rC = await req(jarA, 'POST', '/create-community', { name: `Search-${uid()}` });
  const communityId = rC.data?.community?.id || rC.data?.id;
  await req(jarB, 'POST', `/communities/${communityId}/join`, {});
  const rCh = await req(jarA, 'GET', `/communities/${communityId}/channels`, null);
  const channelId = (Array.isArray(rCh.data) ? rCh.data : (rCh.data?.channels || []))[0]?.id;
  if (!assert('setup: channelId', !!channelId, '')) return;

  const searchToken = `uniq-${uid()}`;
  await req(jarA, 'POST', '/messages', { channelId, content: `findme-${searchToken}` });

  // Wait for ES indexing
  await new Promise(r => setTimeout(r, 2000));

  const rSearch = await req(jarA, 'GET', `/search/messages?q=${searchToken}&scope=community&communityId=${communityId}`, null);
  assert('GET /search/messages returns 200', rSearch.status === 200, `HTTP ${rSearch.status}`);
  const results = Array.isArray(rSearch.data) ? rSearch.data : (rSearch.data?.results || rSearch.data?.hits || []);
  assert('search finds the message', results.length >= 1, `found ${results.length}`);

  // Community directory search
  const commName = `Searchable-${uid()}`;
  await req(jarA, 'POST', '/create-community', { name: commName });
  await new Promise(r => setTimeout(r, 1000));
  const rDir = await req(jarA, 'GET', `/search-communities?q=${commName}`, null);
  assert('GET /search-communities returns 200', rDir.status === 200, `HTTP ${rDir.status}`);
}

async function testPresenceWs() {
  section('WebSocket Presence');
  const jarA = new Jar(), jarB = new Jar();
  const a = await register(jarA, 'a');
  const b = await register(jarB, 'b');

  // Both join same community so they're presence targets
  const rC = await req(jarA, 'POST', '/create-community', { name: `Pres-${uid()}` });
  const communityId = rC.data?.community?.id || rC.data?.id;
  await req(jarB, 'POST', `/communities/${communityId}/join`, {});

  const connA = await connectWs(jarA).catch(() => null);
  if (!connA) { fail('WS connect A', 'failed'); return; }

  // Wait for presence snapshot
  try {
    const ev = await waitWs(connA, msg => msg.type === 'presence_update', 5000);
    assert('presence_update received on connect', ev.type === 'presence_update', ev.type);
    assert('presence_update has userId', !!ev.userId, ev.userId);
    assert('presence_update has status', !!ev.status, ev.status);
  } catch (e) {
    fail('presence_update on connect', e.message);
  }

  closeWs(connA);
}

// ── Run All ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${Y('══════════════════════════════════════════════════════')}`);
  console.log(`  API Test Suite`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`${Y('══════════════════════════════════════════════════════')}`);

  await testAuth();
  await testCommunities();
  await testChannels();
  await testChannelMessages();
  await testDMs();
  await testReadState();
  await testSearch();
  await testPresenceWs();

  // Summary
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
