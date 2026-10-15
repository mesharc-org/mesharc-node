import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshArc, MeshArcError, MeshArcTimeoutError, TENANT_HEADER } from '../dist/index.js';

/** A fetch that answers from a script of responses and records what it was asked. */
function client(script, options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(String(url)), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    const { status = 200, body = {}, raw } = next;
    const text = raw !== undefined ? raw : status === 204 ? null : JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { arc: new MeshArc('mesharc_test', { fetch, maxRetries: 0, ...options }), calls };
}

const params = call => Object.fromEntries(call.url.searchParams);

// -- the agent -------------------------------------------------------------------------------

test('an agent run names its login, data providers and proposals only when given', async () => {
  const { arc, calls } = client([{ body: { id: 'r1', status: 'queued' } }, { body: { id: 'r2', status: 'queued' } }]);
  await arc.agent('p');
  await arc.agent('p', { loginId: 'L1', dataConnections: ['c1', 'c2'], proposals: true });
  assert.deepEqual(calls[0].body, { prompt: 'p' });
  assert.deepEqual(calls[1].body, { prompt: 'p', loginId: 'L1', dataConnections: ['c1', 'c2'], proposals: true });
});

test('logins need no picking: sent only to change the API\'s auto', async () => {
  const { arc, calls } = client([{ body: { id: 'r1', status: 'queued' } }, { body: { id: 'r2', status: 'queued' } },
    { body: { valid: 1 } }]);
  await arc.agent('p');
  await arc.agent('p', { logins: ['l1', 'l2'] });
  await arc.agentBatches.preview('about {{co}}', { csv: 'co\nAcme\n', maxCreditsPerRow: 10, logins: 'none' });
  assert.equal('logins' in calls[0].body, false);
  assert.deepEqual([calls[1].body.logins, calls[2].body.logins], [['l1', 'l2'], 'none']);
});

test('a follow-up posts its own request to the run\'s conversation, with its key', async () => {
  const { arc, calls } = client([{ body: { id: 'r1', status: 'done' } }, { body: { id: 'r2', status: 'queued', followsRunId: 'r1' } }]);
  const first = await arc.getAgent('r1');
  const next = await first.followUp('and prices?', { maxCredits: 300, apiTimeoutS: 500, idempotencyKey: 'f-1' });
  assert.equal(calls[1].url.pathname, '/api/v1/agent/r1/follow-up');
  assert.equal(calls[1].headers['Idempotency-Key'], 'f-1');
  assert.deepEqual(calls[1].body, { prompt: 'and prices?', maxCredits: 300, timeout: 120 });
  assert.equal(next.id, 'r2');
});

test('a follow-up of a message that is not the latest is a 409', async () => {
  const { arc } = client([{ body: { id: 'r1', status: 'done' } },
    { status: 409, body: { error: 'this is not the conversation\'s latest message', code: 'conflict' } }]);
  const first = await arc.getAgent('r1');
  await assert.rejects(first.followUp('x'), e => e instanceof MeshArcError && e.status === 409 && e.code === 'conflict');
});

test('conversations follow the cursor and keep the filter; one is read whole', async () => {
  const { arc, calls } = client([
    { body: { data: [{ id: 't1' }], next: '/api/v1/agent/conversations?limit=1&cursor=1&q=acme' } },
    { body: { data: [{ id: 't2' }], next: null } }, { body: { id: 't1', runs: [] } }]);
  const ids = [];
  for await (const c of arc.conversations({ q: 'acme', limit: 1 })) ids.push(c.id);
  assert.deepEqual(ids, ['t1', 't2']);
  assert.deepEqual(params(calls[1]), { q: 'acme', limit: '1', cursor: '1' });
  assert.deepEqual(await arc.conversation('t1'), { id: 't1', runs: [] });
});

// -- tables -------------------------------------------------------------------------------------

test('a table is previewed and started in the API\'s names; the key goes as a header, not in the body', async () => {
  const { arc, calls } = client([{ body: { valid: 2 } }, { body: { id: 'b1', status: 'queued', webhookSecret: 'whsec' } }]);
  const table = { csv: 'co,site\nAcme,acme.test\n', maxCreditsPerRow: 50, urls: ['{{site}}'], allowedDomains: [], dataConnections: ['c1'] };
  await arc.agentBatches.preview('about {{co}}', table);
  const out = await arc.agentBatches.start('about {{co}}', { ...table, webhook: 'https://hook.test/', idempotencyKey: 'b-1' });
  const want = { prompt: 'about {{co}}', ...table };
  assert.deepEqual([calls[0].url.pathname, calls[0].body], ['/api/v1/agent/batch/preview', want]);
  assert.deepEqual([calls[1].url.pathname, calls[1].body], ['/api/v1/agent/batch', { ...want, webhook: 'https://hook.test/' }]);
  assert.equal(calls[1].headers['Idempotency-Key'], 'b-1');
  assert.equal(out.webhookSecret, 'whsec');
});

test('a table\'s rows are read page by page until there is no more', async () => {
  const { arc, calls } = client([{ body: { data: [{ row: 0 }, { row: 1 }], more: '/api/v1/agent/batch/b1?offset=2' } },
    { body: { data: [{ row: 2 }] } }]);
  const rows = [];
  for await (const r of arc.agentBatches.rows('b1', { status: 'done', limit: 2 })) rows.push(r.row);
  assert.deepEqual(rows, [0, 1, 2]);
  assert.deepEqual(params(calls[1]), { offset: '2', limit: '2', status: 'done' });
});

test('waiting for a table polls until it ends, and times out plainly', async () => {
  let { arc } = client([{ body: { id: 'b1', status: 'running' } }, { body: { id: 'b1', status: 'done' } }]);
  assert.equal((await arc.agentBatches.wait('b1', { pollMs: 0 })).status, 'done');
  ({ arc } = client([{ body: { id: 'b1', status: 'running' } }]));
  await assert.rejects(arc.agentBatches.wait('b1', { pollMs: 0, timeoutMs: -1 }), e => e instanceof MeshArcTimeoutError && e.jobId === 'b1');
});

test('a table downloads as a Response; an expired one is a 410', async () => {
  const { arc, calls } = client([{ raw: 'co,plan\nAcme,Pro\n' }, { status: 410, body: { error: 'past its keep date', code: 'expired' } }]);
  const res = await arc.agentBatches.export('b1', 'jsonl');
  assert.equal(await res.text(), 'co,plan\nAcme,Pro\n');
  assert.deepEqual(params(calls[0]), { format: 'jsonl' });
  await assert.rejects(arc.agentBatches.get('b1'), e => e.status === 410 && e.code === 'expired');
});

// -- monitors -------------------------------------------------------------------------------------

test('a monitor is made with its caps, alerts and records, and changed with values that clear a setting', async () => {
  const { arc, calls } = client([{ body: { id: 'm1' } }, { body: { id: 'm1' } }]);
  await arc.monitors.create('agent', { prompt: 'p' }, 'daily', { budget: { perRun: 100, perMonth: 2000 }, alerts: { email: true },
    rows: { path: 'plans', key: 'name' }, destination: 'd1' });
  await arc.monitors.update('m1', { budget: {}, addToProject: '', sentiment: false });
  assert.deepEqual(calls[0].body, { kind: 'agent', request: { prompt: 'p' }, schedule: 'daily', budget: { perRun: 100, perMonth: 2000 },
    alerts: { email: true }, rows: { path: 'plans', key: 'name' }, destination: 'd1' });
  assert.deepEqual(calls[1].body, { budget: {}, addToProject: '', sentiment: false });
});

test('a monitor\'s records are paged by offset; its events, one record and the overview are read', async () => {
  const { arc, calls } = client([{ body: { data: [{ key: 'a' }, { key: 'b' }], total: 3 } }, { body: { data: [{ key: 'c' }], total: 3 } },
    { body: { data: [{ kind: 'added' }] } }, { body: { key: 'a', events: [] } }, { body: { data: [], counts: {} } }]);
  const keys = [];
  for await (const r of arc.monitors.rows('m1', { active: false, limit: 2 })) keys.push(r.key);
  assert.deepEqual(keys, ['a', 'b', 'c']);
  assert.deepEqual(params(calls[0]), { active: 'false', offset: '0', limit: '2' });
  assert.deepEqual(await arc.monitors.rowEvents('m1', { runId: 'mr1' }), [{ kind: 'added' }]);
  assert.deepEqual(params(calls[2]), { run_id: 'mr1', limit: '200' });
  assert.equal((await arc.monitors.row('m1', 'a b')).key, 'a');
  assert.equal(calls[3].url.pathname, '/api/v1/monitors/m1/rows/a%20b');
  await arc.monitors.overview({ kind: 'agent' });
  assert.equal(calls[4].url.pathname, '/api/v1/monitors/overview');
});

// -- triggers, proposals, estimate ---------------------------------------------------------------------

test('a trigger is made, listed, changed, its fires followed, previewed and deleted', async () => {
  const { arc, calls } = client([{ body: { id: 't1' } }, { body: { data: [{ id: 't1' }] } }, { body: { id: 't1', status: 'paused' } },
    { body: { data: [{ id: 'f1' }], next: '/api/v1/triggers/t1/fires?cursor=1' } }, { body: { data: [{ id: 'f2' }], next: null } },
    { body: { matched: 1 } }, { body: { id: 't1', deleted: true } }]);
  await arc.triggers.create({ kind: 'project', id: 'p1' }, { type: 'recrawl' }, { limits: { maxPerDay: 2 } });
  assert.deepEqual(calls[0].body, { source: { kind: 'project', id: 'p1' }, action: { type: 'recrawl' }, limits: { maxPerDay: 2 } });
  assert.deepEqual(await arc.triggers.list({ sourceId: 'p1' }), [{ id: 't1' }]);
  assert.deepEqual(params(calls[1]), { source_id: 'p1' });
  await arc.triggers.update('t1', { status: 'paused' });
  assert.deepEqual([calls[2].method, calls[2].body], ['PATCH', { status: 'paused' }]);
  const fires = [];
  for await (const f of arc.triggers.fires('t1')) fires.push(f.id);
  assert.deepEqual(fires, ['f1', 'f2']);
  assert.deepEqual(await arc.triggers.preview('t1'), { matched: 1 });
  assert.equal((await arc.triggers.delete('t1')).deleted, true);
});

test('proposals are listed waiting by default, and approved or dismissed', async () => {
  const { arc, calls } = client([{ body: { data: [{ id: 'pr1' }] } }, { body: { made: { kind: 'monitor', id: 'm1' } } },
    { status: 409, body: { error: 'already decided', code: 'conflict' } }]);
  assert.deepEqual(await arc.proposals.list(), [{ id: 'pr1' }]);
  assert.deepEqual(params(calls[0]), { status: 'proposed' });
  assert.equal((await arc.proposals.approve('pr1')).made.id, 'm1');
  await assert.rejects(arc.proposals.dismiss('pr1'), e => e.code === 'conflict');
});

test('the estimate sends the API\'s names and only what was given', async () => {
  const { arc, calls } = client([{ body: { perMonth: 120, upTo: true } }]);
  await arc.estimate('agent', 'weekly', { maxCredits: 300, monthCap: 0 });
  assert.deepEqual(params(calls[0]), { kind: 'agent', schedule: 'weekly', maxCredits: '300', monthCap: '0' });
});

// -- sub-accounts, connections, logins --------------------------------------------------------------

test('sub-accounts are made, suspended and given keys', async () => {
  const { arc, calls } = client([{ body: { id: 's1' } }, { body: { id: 's1', suspended: true } }, { body: { id: 'k1', key: 'mesharc_x' } },
    { status: 204 }]);
  await arc.subAccounts.create('Acme', { monthlyCap: 5000, externalId: 'cust-1', idempotencyKey: 's-1' });
  assert.deepEqual(calls[0].body, { name: 'Acme', monthlyCap: 5000, externalId: 'cust-1' });
  assert.equal(calls[0].headers['Idempotency-Key'], 's-1');
  await arc.subAccounts.update('s1', { suspended: true, reason: 'unpaid' });
  assert.equal((await arc.subAccounts.createKey('s1', 'acme', { scopes: ['read'] })).key, 'mesharc_x');
  assert.deepEqual(calls[2].body, { name: 'acme', scopes: ['read'] });
  await arc.subAccounts.revokeKey('s1', 'k1');
  assert.deepEqual([calls[3].method, calls[3].url.pathname], ['DELETE', '/api/v1/orgs/children/s1/keys/k1']);
});

test('a client for a sub-account sends the tenant header on every request; the parent does not', async () => {
  const { arc, calls } = client([{ body: { id: 'parent' } }, { body: { id: 's1' } }], { baseUrl: 'http://localhost:8010' });
  const child = arc.asSubAccount('s1');
  await arc.me();
  await child.me();
  assert.equal(calls[0].headers[TENANT_HEADER], undefined);
  assert.equal(calls[1].headers[TENANT_HEADER], 's1');
  assert.equal(calls[1].headers.Authorization, 'Bearer mesharc_test');
  assert.equal(calls[1].url.origin + calls[1].url.pathname, 'http://localhost:8010/api/v1/me');
  assert.equal(child.tenant, 's1');
});

test('a data provider is connected with its key and tested; saved logins are listed, expired and deleted', async () => {
  const { arc, calls } = client([{ body: { id: 'c1', kind: 'data provider' } }, { body: { status: 'failing', error: 'refused the key (401)' } },
    { body: { connections: [{ id: 'c1' }] } }, { body: { data: [], enabled: false } }, { body: { id: 'l1', status: 'expired' } },
    { status: 204 }]);
  await arc.connections.create('pdl', { name: 'Company data', secrets: { api_key: 'k' } });
  assert.deepEqual(calls[0].body, { provider: 'pdl', name: 'Company data', secrets: { api_key: 'k' } });
  assert.equal((await arc.connections.test('c1')).status, 'failing');
  assert.deepEqual(await arc.connections.list(), [{ id: 'c1' }]);
  assert.equal((await arc.logins.list()).enabled, false);
  await arc.logins.update('l1', { expired: true });
  assert.deepEqual(calls[4].body, { expired: true });
  await arc.logins.delete('l1');
  assert.equal(calls[5].method, 'DELETE');
});
