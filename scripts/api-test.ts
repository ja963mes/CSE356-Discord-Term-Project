/**
 * Full API test suite using the generated client.
 *
 * Usage:
 *   npx tsx scripts/api-test.ts https://group-6.cse356.compas.cs.stonybrook.edu
 *   npm run test:api
 */
import { GeneratedClient, type MessageInfo } from './generated-client.js';
import { fetchWithRetry, CookieJar } from './test-harness/helpers.js';

const BASE_URL = (process.argv.find(a => a.startsWith('http')) || 'http://localhost:5173').replace(/\/$/, '');

const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

let passed = 0, failed = 0;
const failures: { label: string; detail: string }[] = [];

function ok(label: string, detail = '') {
  passed++;
  console.log(`  ${G('✓')}  ${label.padEnd(52)} ${DIM(detail)}`);
}
function fail(label: string, detail = '') {
  failed++;
  failures.push({ label, detail });
  console.log(`  ${R('✗')}  ${label.padEnd(52)} ${R(detail)}`);
}
function section(name: string) {
  console.log(`\n${Y('━━')} ${name} ${Y('━'.repeat(Math.max(0, 54 - name.length)))}`);
}
function assert(label: string, condition: boolean, detail = ''): boolean {
  if (condition) ok(label, detail);
  else fail(label, detail);
  return condition;
}
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Wrap a GeneratedClient call — fail the assertion and return null on throw.
async function wrap<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const result = await fn();
    return result;
  } catch (e: any) {
    fail(label, e.message);
    return null;
  }
}

// Wait for the next WS message matching predicate (set callback BEFORE sending).
function awaitMessage(client: GeneratedClient, match: (m: MessageInfo) => boolean, ms = 8_000): Promise<MessageInfo> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('message event timeout')), ms);
    client.onMessage((m) => {
      if (match(m)) { clearTimeout(t); resolve(m); }
    });
  });
}

function awaitPresence(client: GeneratedClient, match: (e: { userId: string; presence: string }) => boolean, ms = 8_000): Promise<{ userId: string; presence: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('presence event timeout')), ms);
    client.onPresence((e) => {
      if (match(e)) { clearTimeout(t); resolve(e); }
    });
  });
}

// Raw HTTP for endpoints not in GeneratedClient (e.g. leaveCommunity, search-communities).
async function raw(jar: CookieJar, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetchWithRetry(`${BASE_URL}${path}`, init, jar);
  let data: any = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testAuth() {
  section('Auth');
  const client = new GeneratedClient(BASE_URL);
  const username = `t-${uid()}`;

  const user = await wrap('register returns 200/201', () => client.register(username, 'Test1234!'));
  if (!assert('register returns userId', !!user?.id, user?.id ?? '')) { client.disconnect(); return; }

  // Verify display name via getDisplayName
  const dn1 = await wrap('GET /auth/me works', () => client.getDisplayName());
  assert('getDisplayName returns something', !!dn1, dn1 ?? '');

  // Update display name
  const newDisplay = `display-${uid()}`;
  const setOk = await wrap('PATCH /auth/profile returns 200', () => client.setDisplayName(newDisplay));
  if (setOk !== null) ok('PATCH /auth/profile returns 200');

  const dn2 = await wrap('displayName updated', () => client.getDisplayName());
  assert('displayName matches', dn2 === newDisplay, dn2 ?? '');

  // Logout
  const logoutOk = await wrap('POST /auth/logout returns 200/204', () => client.logout());
  if (logoutOk !== null) ok('POST /auth/logout returns 200/204');

  // After logout, getDisplayName should fail
  try {
    await client.getDisplayName();
    fail('GET /auth/me after logout returns 401', 'did not throw');
  } catch {
    ok('GET /auth/me after logout returns 401');
  }

  // Login
  const client2 = new GeneratedClient(BASE_URL);
  const user2 = await wrap('POST /auth/login returns 200', () => client2.login(username, 'Test1234!'));
  assert('login returns userId', !!user2?.id, user2?.id ?? '');

  // Wrong password
  const client3 = new GeneratedClient(BASE_URL);
  try {
    await client3.login(username, 'wrongpassword');
    fail('login with wrong password returns 401', 'did not throw');
  } catch {
    ok('login with wrong password returns 401');
  }

  client.disconnect(); client2.disconnect(); client3.disconnect();
}

async function testCommunities() {
  section('Communities');
  const clientA = new GeneratedClient(BASE_URL);
  const clientB = new GeneratedClient(BASE_URL);
  const usernameA = `t-${uid()}-a`;
  const usernameB = `t-${uid()}-b`;

  const uA = await wrap('register A', () => clientA.register(usernameA, 'Test1234!'));
  const uB = await wrap('register B', () => clientB.register(usernameB, 'Test1234!'));
  if (!uA || !uB) { clientA.disconnect(); clientB.disconnect(); return; }

  const community = await wrap('POST /create-community returns 200/201', () => clientA.createCommunity(`Test-${uid()}`));
  if (!assert('create-community returns id', !!community?.id, community?.id ?? '')) {
    clientA.disconnect(); clientB.disconnect(); return;
  }

  const communities = await wrap('GET /communities returns 200', () => clientA.getCommunities());
  assert('community appears in list', communities?.some(c => c.id === community!.id) ?? false, `found ${communities?.length}`);

  const joinOk = await wrap('POST /communities/:id/join returns 200/201', () => clientB.joinCommunity(community!.id));
  if (joinOk !== null) ok('POST /communities/:id/join returns 200/201');

  const members = await wrap('GET /communities/:id/members returns 200', () => clientA.getCommunityMembers(community!.id));
  assert('B appears in members list', members?.some(m => m.id === uB.id) ?? false, `found ${members?.length} members`);

  // leaveCommunity not in GeneratedClient — raw HTTP via internal jar access
  const jarA = (clientA as any).cookieJar as CookieJar;
  const rLeave = await raw(jarA, 'POST', `/communities/${community!.id}/leave`);
  assert('POST /communities/:id/leave returns 200/204', rLeave.status === 200 || rLeave.status === 204, `HTTP ${rLeave.status}`);

  clientA.disconnect(); clientB.disconnect();
}

async function testChannels() {
  section('Channels');
  const client = new GeneratedClient(BASE_URL);
  await wrap('register', () => client.register(`t-${uid()}`, 'Test1234!'));

  const community = await wrap('create community', () => client.createCommunity(`TestCh-${uid()}`));
  if (!assert('setup: community created', !!community?.id, community?.id ?? '')) { client.disconnect(); return; }

  const channels = await wrap('GET /communities/:id/channels returns 200', () => client.getChannelsInCommunity(community!.id));
  assert('#general channel seeded', (channels?.length ?? 0) >= 1, `found ${channels?.length}`);
  assert('#general is public', channels?.[0]?.isPrivate === false, '');

  const newCh = await wrap('POST /communities/:id/channels returns 200/201', () =>
    client.createChannelInCommunity(community!.id, 'test-channel'));
  assert('new channel has id', !!newCh?.id, newCh?.id ?? '');

  const privCh = await wrap('POST private channel returns 200/201', () =>
    client.createChannelInCommunity(community!.id, 'secret', { isPrivate: true }));
  assert('private channel created', !!privCh?.id, privCh?.id ?? '');

  const channels2 = await wrap('channel list updated', () => client.getChannelsInCommunity(community!.id));
  assert('channel list shows all 3', (channels2?.length ?? 0) >= 3, `found ${channels2?.length}`);
  assert('private channel in list (owner sees all)', channels2?.some(c => c.id === privCh?.id) ?? false, '');

  client.disconnect();
}

async function testChannelMessages() {
  section('Channel Messages + WS Delivery');
  const clientA = new GeneratedClient(BASE_URL);
  const clientB = new GeneratedClient(BASE_URL);

  const uA = await wrap('register A', () => clientA.register(`t-${uid()}-a`, 'Test1234!'));
  const uB = await wrap('register B', () => clientB.register(`t-${uid()}-b`, 'Test1234!'));
  if (!uA || !uB) { clientA.disconnect(); clientB.disconnect(); return; }

  const community = await wrap('create community', () => clientA.createCommunity(`TestMsg-${uid()}`));
  await wrap('B joins', () => clientB.joinCommunity(community!.id));

  const channels = await wrap('get channels', () => clientA.getChannelsInCommunity(community!.id));
  const channelId = channels?.[0]?.id;
  if (!assert('setup: channelId', !!channelId, channelId ?? '')) { clientA.disconnect(); clientB.disconnect(); return; }

  const msg1 = await wrap('POST /messages returns 200/201', () => clientA.sendMessage(channelId!, `msg-${uid()}`));
  assert('send returns messageId', !!msg1?.id, msg1?.id ?? '');

  const history = await wrap('GET /messages returns 200', () => clientA.getMessages(channelId!));
  assert('message appears in history', history?.some(m => m.id === msg1?.id) ?? false, `found ${history?.length}`);

  // WS delivery
  await wrap('WS connect A', () => clientA.enableRealtime());
  await wrap('WS connect B', () => clientB.enableRealtime());
  await new Promise(r => setTimeout(r, 300));

  const content2 = `ws-${uid()}`;
  const wsPromise = awaitMessage(clientB, m => m.content === content2);
  await clientA.sendMessage(channelId!, content2);

  try {
    const ev = await wsPromise;
    assert('channel:message:create delivered via WS', ev.conversationId === channelId, `got: ${ev.conversationId}`);
    assert('WS event has correct content', ev.content === content2, ev.content);
  } catch (e: any) {
    fail('channel WS delivery', e.message);
  }

  clientA.disconnect(); clientB.disconnect();
}

async function testDMs() {
  section('Direct Messages + WS Delivery');
  const clientA = new GeneratedClient(BASE_URL);
  const clientB = new GeneratedClient(BASE_URL);
  const clientC = new GeneratedClient(BASE_URL);

  const uA = await wrap('register A', () => clientA.register(`t-${uid()}-a`, 'Test1234!'));
  const uB = await wrap('register B', () => clientB.register(`t-${uid()}-b`, 'Test1234!'));
  const uC = await wrap('register C', () => clientC.register(`t-${uid()}-c`, 'Test1234!'));
  if (!uA || !uB || !uC) { clientA.disconnect(); clientB.disconnect(); clientC.disconnect(); return; }

  // 1:1 DM
  const dm = await wrap('POST /dms (1:1) returns 200/201', () => clientA.createDM([uB.id]));
  if (!assert('DM has conversationId', !!dm?.id, dm?.id ?? '')) {
    clientA.disconnect(); clientB.disconnect(); clientC.disconnect(); return;
  }

  // Idempotent
  const dm2 = await wrap('POST /dms idempotent returns 200/201', () => clientA.createDM([uB.id]));
  assert('idempotent DM returns id', !!dm2?.id, dm2?.id ?? '');

  const convs = await wrap('GET /dms returns 200', () => clientA.getDMChannels());
  assert('DM appears in list', convs?.some(c => c.id === dm!.id) ?? false, `found ${convs?.length}`);

  const msg1 = await wrap('POST /dms/:id/messages returns 200/201', () => clientA.sendDM(dm!.id, `dm-${uid()}`));
  assert('send DM returns messageId', !!msg1?.id, msg1?.id ?? '');

  const dmHistory = await wrap('GET /dms/:id/messages returns 200', () => clientB.getMessagesDM(dm!.id));
  assert('message appears in DM history', dmHistory?.some(m => m.id === msg1?.id) ?? false, `found ${dmHistory?.length}`);

  // WS delivery
  await wrap('WS connect A', () => clientA.enableRealtime());
  await wrap('WS connect B', () => clientB.enableRealtime());
  await new Promise(r => setTimeout(r, 300));

  const content2 = `dm-ws-${uid()}`;
  const wsPromise = awaitMessage(clientB, m => m.content === content2);
  await clientA.sendDM(dm!.id, content2);

  try {
    const ev = await wsPromise;
    assert('dm:message:create delivered via WS', ev.conversationId === dm!.id, `got: ${ev.conversationId}`);
    assert('WS event has correct content', ev.content === content2, ev.content);
    assert('WS event has authorId', !!ev.authorId, ev.authorId);
  } catch (e: any) {
    fail('DM WS delivery', e.message);
  }

  // Edit DM message (msg1.id = timeuuid)
  if (msg1?.id) {
    const edited = await wrap('PATCH /dms/:id/messages/:id returns 200', () =>
      clientA.editMessage(dm!.id, msg1!.id, 'edited dm content'));
    assert('edit returns message', !!edited?.id, edited?.id ?? '');
  } else {
    fail('skip DM edit (no messageId)', '');
  }

  // Delete DM message
  if (msg1?.id) {
    const deleteOk = await wrap('DELETE /dms/:id/messages/:id returns 200/204', () =>
      clientA.deleteMessage(dm!.id, msg1!.id));
    if (deleteOk !== null) ok('DELETE /dms/:id/messages/:id returns 200/204');
  } else {
    fail('skip DM delete (no messageId)', '');
  }

  // Group DM
  const group = await wrap('POST /dms (group) returns 200/201', () => clientA.createDM([uB.id, uC.id]));
  assert('group DM has conversationId', !!group?.id, group?.id ?? '');

  // Add participant
  const clientD = new GeneratedClient(BASE_URL);
  const uD = await wrap('register D', () => clientD.register(`t-${uid()}-d`, 'Test1234!'));
  if (uD && group) {
    const addOk = await wrap('POST /dms/:id/participants returns 2xx', () => clientA.addDMParticipant(group.id, uD.id));
    if (addOk !== null) ok('POST /dms/:id/participants returns 2xx');
  }

  // Leave DM
  if (group) {
    const leaveOk = await wrap('DELETE /dms/:id/participants/me returns 200/204', () => clientB.leaveDM(group.id));
    if (leaveOk !== null) ok('DELETE /dms/:id/participants/me returns 200/204');
  }

  clientA.disconnect(); clientB.disconnect(); clientC.disconnect(); clientD.disconnect();
}

async function testReadState() {
  section('Read State');
  const clientA = new GeneratedClient(BASE_URL);
  const clientB = new GeneratedClient(BASE_URL);

  const uA = await wrap('register A', () => clientA.register(`t-${uid()}-a`, 'Test1234!'));
  const uB = await wrap('register B', () => clientB.register(`t-${uid()}-b`, 'Test1234!'));
  if (!uA || !uB) { clientA.disconnect(); clientB.disconnect(); return; }

  const dm = await wrap('create DM', () => clientA.createDM([uB.id]));
  if (!assert('setup: DM created', !!dm?.id, dm?.id ?? '')) { clientA.disconnect(); clientB.disconnect(); return; }

  const msg = await wrap('send message', () => clientA.sendDM(dm!.id, `rs-${uid()}`));
  if (!assert('setup: message sent', !!msg?.id, msg?.id ?? '')) { clientA.disconnect(); clientB.disconnect(); return; }

  const counts = await wrap('GET /read-state/dms returns 200', () => clientB.getUnreadCounts());
  assert('getUnreadCounts returns array', Array.isArray(counts), `got ${typeof counts}`);

  const markOk = await wrap('POST /read-state/dms/:id/read returns 200/204', () =>
    clientB.markRead(dm!.id, msg!.id));
  if (markOk !== null) ok('POST /read-state/dms/:id/read returns 200/204');

  clientA.disconnect(); clientB.disconnect();
}

async function testSearch() {
  section('Search');
  const clientA = new GeneratedClient(BASE_URL);
  const clientB = new GeneratedClient(BASE_URL);

  const uA = await wrap('register A', () => clientA.register(`t-${uid()}-a`, 'Test1234!'));
  const uB = await wrap('register B', () => clientB.register(`t-${uid()}-b`, 'Test1234!'));
  if (!uA || !uB) { clientA.disconnect(); clientB.disconnect(); return; }

  const community = await wrap('create community', () => clientA.createCommunity(`Search-${uid()}`));
  await wrap('B joins', () => clientB.joinCommunity(community!.id));

  const channels = await wrap('get channels', () => clientA.getChannelsInCommunity(community!.id));
  const channelId = channels?.[0]?.id;
  if (!assert('setup: channelId', !!channelId, channelId ?? '')) { clientA.disconnect(); clientB.disconnect(); return; }

  const searchToken = `uniq-${uid()}`;
  await clientA.sendMessage(channelId!, `findme-${searchToken}`);

  await new Promise(r => setTimeout(r, 2000)); // ES indexing delay

  const results = await wrap('GET /search/messages returns 200', () =>
    clientA.searchMessages(searchToken, { communityId: community!.id }));
  assert('search finds the message', (results?.length ?? 0) >= 1, `found ${results?.length}`);

  // Community directory search — not in GeneratedClient, use raw HTTP
  const jarA = (clientA as any).cookieJar as CookieJar;
  const commName = `Searchable-${uid()}`;
  await wrap('create searchable community', () => clientA.createCommunity(commName));
  await new Promise(r => setTimeout(r, 1000));
  const rDir = await raw(jarA, 'GET', `/search-communities?q=${encodeURIComponent(commName)}`);
  assert('GET /search-communities returns 200', rDir.status === 200, `HTTP ${rDir.status}`);

  clientA.disconnect(); clientB.disconnect();
}

async function testPresenceWs() {
  section('WebSocket Presence');
  const clientA = new GeneratedClient(BASE_URL);
  const clientB = new GeneratedClient(BASE_URL);

  const uA = await wrap('register A', () => clientA.register(`t-${uid()}-a`, 'Test1234!'));
  const uB = await wrap('register B', () => clientB.register(`t-${uid()}-b`, 'Test1234!'));
  if (!uA || !uB) { clientA.disconnect(); clientB.disconnect(); return; }

  const community = await wrap('create community', () => clientA.createCommunity(`Pres-${uid()}`));
  await wrap('B joins', () => clientB.joinCommunity(community!.id));

  const presencePromise = awaitPresence(clientA, () => true, 5000);
  await wrap('WS connect A', () => clientA.enableRealtime());

  try {
    const ev = await presencePromise;
    assert('presence_update received on connect', !!ev.userId, ev.userId);
    assert('presence_update has status', !!ev.presence, ev.presence);
  } catch (e: any) {
    fail('presence_update on connect', e.message);
  }

  clientA.disconnect(); clientB.disconnect();
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${Y('══════════════════════════════════════════════════════')}`);
  console.log(`  API Test Suite  (generated client)`);
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
