import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { AgentRun, MeshArc, MeshArcError, MeshArcTimeoutError, VERSION } from '../dist/index.js';

/** A fetch that answers from a script of responses and records what it was asked. */
function fakeFetch(script) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    // `raw` sends that exact text as the body, so an empty 200 can be scripted.
    const { status = 200, body = {}, headers = {}, raw } = next;
    const text = raw !== undefined ? raw : status === 204 ? null : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  };
  return { fetch, calls };
}

const client = (script, options = {}) => {
  const f = fakeFetch(script);
  return { arc: new MeshArc('mesharc_test', { fetch: f.fetch, maxRetries: 2, ...options }), calls: f.calls };
};

test('the constructor needs a key and takes it from the environment', () => {
  const had = process.env.MESHARC_API_KEY;
  delete process.env.MESHARC_API_KEY;
  assert.throws(() => new MeshArc(), /API key/);
  process.env.MESHARC_API_KEY = 'mesharc_env';
  assert.ok(new MeshArc({ fetch: async () => new Response('{}') }));
  if (had === undefined) delete process.env.MESHARC_API_KEY; else process.env.MESHARC_API_KEY = had;
});

test('the key is not shown by console.log, inspect or JSON', () => {
  const arc = new MeshArc('mesharc_live_abcdef1234567890', { fetch: async () => new Response('{}') });
  const shown = inspect(arc);
  assert.ok(!shown.includes('abcdef1234567890'), shown);
  assert.ok(shown.includes('mesharc_…7890'), shown);
  assert.ok(!Object.keys(arc).includes('key'));
  assert.ok(!JSON.stringify({ base: arc.base, timeoutMs: arc.timeoutMs }).includes('abcdef'));
});

test('the base URL must be https, except on localhost', () => {
  const f = async () => new Response('{}');
  assert.throws(() => new MeshArc('mesharc_k', { fetch: f, baseUrl: 'http://evil.example' }), /https/);
  assert.throws(() => new MeshArc('mesharc_k', { fetch: f, baseUrl: 'ftp://api.mesharc.dev' }), /https/);
  assert.throws(() => new MeshArc('mesharc_k', { fetch: f, baseUrl: 'not a url' }), /not a URL/);
  assert.ok(new MeshArc('mesharc_k', { fetch: f, baseUrl: 'http://localhost:8000' }));
  assert.ok(new MeshArc('mesharc_k', { fetch: f, baseUrl: 'http://127.0.0.1:8000/' }));
  assert.ok(new MeshArc('mesharc_k', { fetch: f, baseUrl: 'https://staging.mesharc.dev/' }));
  const had = process.env.MESHARC_API_URL;
  process.env.MESHARC_API_URL = 'http://evil.example';
  assert.throws(() => new MeshArc('mesharc_k', { fetch: f }), /https/);
  if (had === undefined) delete process.env.MESHARC_API_URL; else process.env.MESHARC_API_URL = had;
});

test('ids are encoded, so a crafted id stays inside its route', async () => {
  const { arc, calls } = client([{ body: {} }, { body: {} }, { body: {} }]);
  await arc.projects.get('x/../../me/keys');
  await arc.revokeKey('k?admin=1');
  await arc.runs.get('p 1', 'r#2');
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/projects/x%2F..%2F..%2Fme%2Fkeys');
  assert.equal(calls[1].url, 'https://api.mesharc.dev/api/v1/me/keys/k%3Fadmin%3D1');
  assert.equal(calls[2].url, 'https://api.mesharc.dev/api/v1/projects/p%201/runs/r%232');
});

test('a call carries the bearer, the user agent and an idempotency key', async () => {
  const { arc, calls } = client([{ body: { ok: true } }]);
  const out = await arc.call('POST', '/scrape', { url: 'https://a.test/' }, undefined, 'once-1');
  assert.deepEqual(out, { ok: true });
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/scrape');
  assert.equal(calls[0].headers.Authorization, 'Bearer mesharc_test');
  assert.equal(calls[0].headers['User-Agent'], `mesharc-node/${VERSION}`);
  assert.equal(calls[0].headers['Idempotency-Key'], 'once-1');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
});

test('an error response becomes MeshArcError with the code and request id', async () => {
  const { arc } = client([{ status: 402, body: { error: 'no credits left', code: 'plan_limit', request_id: 'req_1' } }]);
  await assert.rejects(arc.me(), err => {
    assert.ok(err instanceof MeshArcError);
    assert.equal(err.status, 402);
    assert.equal(err.code, 'plan_limit');
    assert.equal(err.requestId, 'req_1');
    assert.equal(err.detail, 'no credits left');
    return true;
  });
});

test('a GET is retried on 429 and honours Retry-After', async () => {
  const { arc, calls } = client([
    { status: 429, body: { error: 'slow down', code: 'rate_limited' }, headers: { 'Retry-After': '0' } },
    { body: { id: 'ws' } },
  ]);
  const out = await arc.me();
  assert.deepEqual(out, { id: 'ws' });
  assert.equal(calls.length, 2);
});

test('a POST without an idempotency key is not retried', async () => {
  const { arc, calls } = client([{ status: 503, body: { error: 'down' } }, { body: {} }]);
  await assert.rejects(arc.call('POST', '/crawl', { url: 'https://a.test/' }), err => err.status === 503);
  assert.equal(calls.length, 1);
});

test('a network failure is retried, then reported as status 0', async () => {
  const { arc, calls } = client([new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed')]);
  await assert.rejects(arc.me(), err => err instanceof MeshArcError && err.status === 0 && err.code === 'network');
  assert.equal(calls.length, 3);
});

test('scrape of one URL returns the page, polling when the API answers with a job', async () => {
  const { arc, calls } = client([
    { body: { id: 'j1', status: 'running' } },
    { body: { id: 'j1', status: 'done', data: [{ url: 'https://a.test/', markdown: '# Hi', credits: 1 }] } },
  ]);
  const page = await arc.scrape('https://a.test/', { render_js: 'auto' }, { pollMs: 1 });
  assert.equal(page.markdown, '# Hi');
  assert.deepEqual(calls[0].body, { url: 'https://a.test/', formats: 'markdown', timeout: 60, config: { render_js: 'auto' } });
  assert.equal(calls[1].method, 'GET');
});

test('a job that stays running past the deadline throws MeshArcTimeoutError with the id', async () => {
  const { arc } = client([{ body: { id: 'j2', status: 'running' } }, { body: { id: 'j2', status: 'running' } }]);
  await assert.rejects(arc.scrape('https://a.test/', undefined, { pollMs: 1, timeoutMs: -1 }), err => {
    assert.ok(err instanceof MeshArcTimeoutError);
    assert.equal(err.jobId, 'j2');
    return true;
  });
});

test('a crawl handle pages through its rows and follows the cursor', async () => {
  const { arc, calls } = client([
    { body: { id: 'c1', status: 'running', url: 'https://d.test/', webhookSecret: 'whsec_x' } },
    { body: { id: 'c1', status: 'running', data: [{ url: 'https://d.test/a' }], next: '/api/v1/crawl/c1?cursor=abc', cursor: 'abc' } },
    { body: { id: 'c1', status: 'done', data: [{ url: 'https://d.test/b' }], cursor: 'def' } },
  ]);
  const job = await arc.crawl('https://d.test/', { limit: 2 });
  assert.equal(job.webhookSecret, 'whsec_x');
  const urls = [];
  for await (const p of job.pages({ pollMs: 1 })) urls.push(p.url);
  assert.deepEqual(urls, ['https://d.test/a', 'https://d.test/b']);
  assert.equal(job.status, 'done');
  assert.match(calls[2].url, /cursor=abc/);
});

test('export resolves to the raw response', async () => {
  const { arc, calls } = client([{ body: { rows: 1 } }]);
  const res = await arc.export('p1', { dataset: 'pages', format: 'csv' });
  assert.equal(res.status, 200);
  assert.match(calls[0].url, /\/projects\/p1\/export\?dataset=pages&format=csv$/);
});

test('a 204 resolves to undefined', async () => {
  const { arc } = client([{ status: 204 }]);
  assert.equal(await arc.revokeKey('k1'), undefined);
});

test('a key out of requests waits for its window before the next call', async () => {
  const { arc, calls } = client([
    { body: { a: 1 }, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '0.3' } },
    { body: { b: 2 } },
  ]);
  await arc.call('GET', '/me');
  const started = Date.now();
  await arc.call('GET', '/me');
  assert.ok(Date.now() - started >= 200, 'the second call waited for the window');
  assert.equal(calls.length, 2);
});

test('pace does not wait while the key has requests to spare', async () => {
  const { arc } = client([{ body: {}, headers: { 'X-RateLimit-Remaining': '50', 'X-RateLimit-Reset': '30' } }]);
  await arc.call('GET', '/me');
  const started = Date.now();
  await arc.pace();
  assert.ok(Date.now() - started < 100);
});

const searchDone = (id, extra = {}) => ({
  id, kind: 'search', status: 'done', query: 'mesh', params: {}, data: [{ position: 1, url: 'https://a.test/', title: 'A', snippet: 's', source: 'web', engine: 'google' }],
  engine: 'google', rung: 'http', cached: false, batchId: null, creditsUsed: 1, attempts: [], next: null, error: '', createdAt: null, finishedAt: null, request_id: 'req_s', ...extra,
});

test('webSearch answered at once sends camelCase fields and resolves the whole envelope', async () => {
  const envelope = searchDone('s1');
  const { arc, calls } = client([{ body: envelope }]);
  const out = await arc.webSearch('mesh', { limit: 3, freshness: 'week', includeDomains: ['a.test'], scrape: true, idempotencyKey: 'ws-1' });
  assert.deepEqual(out, envelope);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/search');
  assert.deepEqual(calls[0].body, { query: 'mesh', limit: 3, freshness: 'week', includeDomains: ['a.test'], scrape: { formats: ['markdown'] }, timeout: 60 });
  assert.equal(calls[0].headers['Idempotency-Key'], 'ws-1');
});

test('a queued web search is polled at /search/{id} with no query string until done', async () => {
  const { arc, calls } = client([
    { body: { id: 's2', status: 'queued' } },
    { body: { id: 's2', status: 'running' } },
    { body: searchDone('s2') },
  ]);
  const out = await arc.webSearch('mesh', { pollMs: 1 });
  assert.equal(out.status, 'done');
  assert.equal(calls.length, 3);
  for (const c of calls.slice(1)) {
    assert.equal(c.method, 'GET');
    assert.equal(c.url, 'https://api.mesharc.dev/api/v1/search/s2');
  }
});

test('a blocked web search resolves rather than throws', async () => {
  const { arc } = client([{ body: { id: 's3', status: 'running' } }, { body: searchDone('s3', { status: 'blocked', data: [] }) }]);
  const out = await arc.webSearch('mesh', { pollMs: 1 });
  assert.equal(out.status, 'blocked');
  assert.deepEqual(out.data, []);
});

test('a failed web search throws MeshArcError 502 job_failed with the API text, or "search error"', async () => {
  const { arc } = client([{ body: { id: 's4', status: 'error', error: 'engines down' } }]);
  await assert.rejects(arc.webSearch('mesh'), err => {
    assert.ok(err instanceof MeshArcError);
    assert.equal(err.status, 502);
    assert.equal(err.code, 'job_failed');
    assert.equal(err.detail, 'engines down');
    return true;
  });
  const empty = client([{ body: { id: 's5', status: 'error', error: '' } }]);
  await assert.rejects(empty.arc.webSearch('mesh'), err => err instanceof MeshArcError && err.status === 502 && err.code === 'job_failed' && err.detail === 'search error');
});

test('webSearch wait:false sends timeout 0 once; apiTimeoutS wins; scrape:false sends no scrape', async () => {
  const { arc, calls } = client([
    { body: { id: 's6', status: 'queued' } },
    { body: { id: 's7', status: 'queued' } },
    { body: searchDone('s8') },
  ]);
  const queued = await arc.webSearch('mesh', { wait: false });
  assert.equal(queued.status, 'queued');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.timeout, 0);
  await arc.webSearch('mesh', { wait: false, apiTimeoutS: 30 });
  assert.equal(calls[1].body.timeout, 30);
  assert.equal(calls.length, 2);
  await arc.webSearch('mesh', { scrape: false });
  assert.deepEqual(calls[2].body, { query: 'mesh', timeout: 60 });
  assert.ok(!('scrape' in calls[2].body));
});

test('a web search past timeoutMs throws MeshArcTimeoutError, also a MeshArcError', async () => {
  const { arc } = client([{ body: { id: 's9', status: 'running' } }]);
  await assert.rejects(arc.webSearch('mesh', { pollMs: 1, timeoutMs: -1 }), err => {
    assert.ok(err instanceof MeshArcTimeoutError);
    assert.ok(err instanceof MeshArcError);
    assert.equal(err.name, 'MeshArcTimeoutError');
    assert.equal(err.jobId, 's9');
    assert.equal(err.status, 0);
    assert.equal(err.code, 'timeout');
    assert.equal(err.message, 'search s9 is still running');
    assert.ok(!err.message.startsWith('0: '));
    return true;
  });
});

test('getSearch reads one search; searches pages with q and limit re-sent', async () => {
  const { arc, calls } = client([
    { body: searchDone('s10') },
    { body: { data: [{ id: 'a' }, { id: 'b' }], next: '/api/v1/search?q=mesh&limit=2&cursor=c1' } },
    { body: { data: [{ id: 'c' }], next: null } },
  ]);
  const one = await arc.getSearch('s10');
  assert.equal(one.id, 's10');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/search/s10');
  const ids = [];
  for await (const row of arc.searches({ q: 'mesh', limit: 2 })) ids.push(row.id);
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.equal(calls.length, 3);
  const first = new URL(calls[1].url);
  assert.equal(first.pathname, '/api/v1/search');
  assert.equal(first.searchParams.get('q'), 'mesh');
  assert.equal(first.searchParams.get('limit'), '2');
  assert.equal(first.searchParams.get('cursor'), null);
  const second = new URL(calls[2].url);
  assert.equal(second.searchParams.get('q'), 'mesh');
  assert.equal(second.searchParams.get('limit'), '2');
  assert.equal(second.searchParams.get('cursor'), 'c1');
});

test('call on an empty 200 resolves to undefined; project search still POSTs pages/search', async () => {
  const { arc, calls } = client([{ raw: '' }, { body: { hits: [] } }]);
  assert.equal(await arc.call('GET', '/me'), undefined);
  const out = await arc.search('p1', 'hello');
  assert.deepEqual(out, { hits: [] });
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, 'https://api.mesharc.dev/api/v1/projects/p1/pages/search');
  assert.deepEqual(calls[1].body, { mode: 'content', q: 'hello' });
});

const agentRun = (id, status, extra = {}) => ({
  id, kind: 'agent', status, prompt: 'find it', params: {}, data: null, sources: [], creditsUsed: 0, budget: 2000, budgetLimited: false,
  tokens: { in: 0, out: 0 }, steps: 0, model: 'm', threadId: id, stopReason: '', error: '', next: `/api/v1/agent/${id}`,
  createdAt: null, startedAt: null, finishedAt: null, expiresAt: null, request_id: 'req_a', ...extra,
});

test('agent sends only the fields given, caps timeout at 120 and leaves it out when 0', async () => {
  const { arc, calls } = client([
    { status: 202, body: agentRun('a1', 'queued') },
    { status: 202, body: agentRun('a2', 'queued') },
    { status: 202, body: agentRun('a3', 'queued') },
  ]);
  await arc.agent('find it', { urls: ['https://a.test/'], schema: { type: 'object' }, maxCredits: 50, maxSteps: 5, allowedDomains: ['a.test'], apiTimeoutS: 500, idempotencyKey: 'ag-1' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/agent');
  assert.deepEqual(calls[0].body, { prompt: 'find it', urls: ['https://a.test/'], schema: { type: 'object' }, maxCredits: 50, maxSteps: 5, allowedDomains: ['a.test'], timeout: 120 });
  assert.equal(calls[0].headers['Idempotency-Key'], 'ag-1');
  await arc.agent('find it', { maxCredits: undefined, apiTimeoutS: 0 });
  assert.deepEqual(calls[1].body, { prompt: 'find it' });
  assert.equal(calls[1].headers['Idempotency-Key'], undefined);
  await arc.agent('find it', { apiTimeoutS: 30 });
  assert.deepEqual(calls[2].body, { prompt: 'find it', timeout: 30 });
});

test('agent resolves an AgentRun with the id, status and envelope', async () => {
  const envelope = agentRun('a4', 'done', { data: { text: 'yes' }, sources: [{ url: 'https://a.test/', title: 'A', pageId: 'p1' }], next: null });
  const { arc, calls } = client([{ body: envelope }]);
  const run = await arc.agent('find it');
  assert.ok(run instanceof AgentRun);
  assert.equal(run.id, 'a4');
  assert.equal(run.status, 'done');
  assert.deepEqual(run.data, { text: 'yes' });
  assert.deepEqual(run.sources, [{ url: 'https://a.test/', title: 'A', pageId: 'p1' }]);
  assert.deepEqual(run.envelope, envelope);
  assert.equal(calls.length, 1);
});

test('AgentRun.wait polls /agent/{id} from queued through running to done', async () => {
  const { arc, calls } = client([
    { status: 202, body: agentRun('a5', 'queued') },
    { body: agentRun('a5', 'running') },
    { body: agentRun('a5', 'done', { data: { text: 'ok' }, next: null }) },
  ]);
  const run = await arc.agent('find it');
  const out = await run.wait({ pollMs: 1 });
  assert.equal(out.status, 'done');
  assert.deepEqual(out.data, { text: 'ok' });
  assert.equal(run.status, 'done');
  assert.equal(calls.length, 3);
  for (const c of calls.slice(1)) {
    assert.equal(c.method, 'GET');
    assert.equal(c.url, 'https://api.mesharc.dev/api/v1/agent/a5');
  }
});

test('AgentRun.wait resolves at credit_limit and at cancelled', async () => {
  const { arc } = client([
    { status: 202, body: agentRun('a6', 'running') },
    { body: agentRun('a6', 'credit_limit', { data: { partial: { n: 1 } }, next: null }) },
    { status: 202, body: agentRun('a7', 'queued') },
    { body: agentRun('a7', 'cancelled', { next: null }) },
  ]);
  const limited = await (await arc.agent('find it')).wait({ pollMs: 1 });
  assert.equal(limited.status, 'credit_limit');
  assert.deepEqual(limited.data, { partial: { n: 1 } });
  const cancelled = await (await arc.agent('find it')).wait({ pollMs: 1 });
  assert.equal(cancelled.status, 'cancelled');
});

test('AgentRun.wait throws MeshArcError 502 job_failed with the API text, or "agent error"', async () => {
  const { arc } = client([
    { status: 202, body: agentRun('a8', 'running') },
    { body: agentRun('a8', 'error', { error: 'model refused', next: null }) },
    { body: agentRun('a9', 'error', { error: '', next: null }) },
  ]);
  const run = await arc.agent('find it');
  await assert.rejects(run.wait({ pollMs: 1 }), err => {
    assert.ok(err instanceof MeshArcError);
    assert.equal(err.status, 502);
    assert.equal(err.code, 'job_failed');
    assert.equal(err.detail, 'model refused');
    return true;
  });
  await assert.rejects((await arc.agent('find it')).wait(), err => err.status === 502 && err.code === 'job_failed' && err.detail === 'agent error');
});

test('AgentRun.wait past timeoutMs throws MeshArcTimeoutError naming the run', async () => {
  const { arc } = client([{ status: 202, body: agentRun('a10', 'running') }]);
  const run = await arc.agent('find it');
  await assert.rejects(run.wait({ pollMs: 1, timeoutMs: -1 }), err => {
    assert.ok(err instanceof MeshArcTimeoutError);
    assert.ok(err instanceof MeshArcError);
    assert.equal(err.jobId, 'a10');
    assert.equal(err.code, 'timeout');
    assert.equal(err.message, 'agent a10 is still running');
    return true;
  });
});

test('AgentRun.cancel sends DELETE, resolves the API answer and leaves the envelope as it was', async () => {
  const { arc, calls } = client([
    { status: 202, body: agentRun('a11', 'running') },
    { body: { id: 'a11', status: 'cancelling' } },
  ]);
  const run = await arc.agent('find it');
  const before = run.envelope;
  const out = await run.cancel();
  assert.deepEqual(out, { id: 'a11', status: 'cancelling' });
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[1].url, 'https://api.mesharc.dev/api/v1/agent/a11');
  assert.equal(run.envelope, before);
  assert.equal(run.status, 'running');
});

test('getAgent reads /agent/{id} and passes a 410 through as status 410, code expired', async () => {
  const { arc, calls } = client([
    { body: agentRun('a 12', 'done', { next: null }) },
    { status: 410, body: { error: 'this agent run has expired', code: 'expired', request_id: 'req_g' } },
  ]);
  const run = await arc.getAgent('a 12');
  assert.ok(run instanceof AgentRun);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/agent/a%2012');
  await assert.rejects(arc.getAgent('old'), err => {
    assert.ok(err instanceof MeshArcError);
    assert.equal(err.status, 410);
    assert.equal(err.code, 'expired');
    assert.equal(err.detail, 'this agent run has expired');
    return true;
  });
});

test('agentRuns pages with status and limit re-sent', async () => {
  const { arc, calls } = client([
    { body: { data: [{ id: 'a' }, { id: 'b' }], next: '/api/v1/agent?status=done&limit=2&cursor=c1' } },
    { body: { data: [{ id: 'c' }], next: null } },
  ]);
  const ids = [];
  for await (const row of arc.agentRuns({ status: 'done', limit: 2 })) ids.push(row.id);
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.equal(calls.length, 2);
  const first = new URL(calls[0].url);
  assert.equal(first.pathname, '/api/v1/agent');
  assert.equal(first.searchParams.get('status'), 'done');
  assert.equal(first.searchParams.get('limit'), '2');
  assert.equal(first.searchParams.get('cursor'), null);
  const second = new URL(calls[1].url);
  assert.equal(second.searchParams.get('status'), 'done');
  assert.equal(second.searchParams.get('limit'), '2');
  assert.equal(second.searchParams.get('cursor'), 'c1');
});

const step = (seq, kind = 'model') => ({ seq, t: '2026-10-07T00:00:00Z', kind, text: `step ${seq}` });

test('AgentRun.trace refreshes before each drain, yields in order across rounds and stops after the drain that follows a final status', async () => {
  const { arc, calls } = client([
    { status: 202, body: agentRun('a13', 'queued') },
    { body: agentRun('a13', 'running') },
    { body: { data: [step(1, 'start'), step(2)], last: 2 } },
    { body: agentRun('a13', 'done', { next: null }) },
    { body: { data: [step(3, 'finish')], last: 3 } },
  ]);
  const run = await arc.agent('find it');
  const seqs = [];
  for await (const e of run.trace({ pollMs: 1 })) seqs.push(e.seq);
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.equal(calls.length, 5);
  assert.equal(calls[1].url, 'https://api.mesharc.dev/api/v1/agent/a13');
  const firstDrain = new URL(calls[2].url);
  assert.equal(firstDrain.pathname, '/api/v1/agent/a13/trace');
  assert.equal(firstDrain.searchParams.get('after'), '0');
  assert.equal(firstDrain.searchParams.get('limit'), '500');
  assert.equal(calls[3].url, 'https://api.mesharc.dev/api/v1/agent/a13');
  assert.equal(new URL(calls[4].url).searchParams.get('after'), '2');
  assert.equal(run.status, 'done');
});

test('AgentRun.trace with follow:false drains once from after, without a refresh', async () => {
  const full = Array.from({ length: 500 }, (_, i) => step(i + 6));
  const { arc, calls } = client([
    { status: 202, body: agentRun('a14', 'running') },
    { body: { data: full, last: 505 } },
    { body: { data: [step(506)], last: 506 } },
  ]);
  const run = await arc.agent('find it');
  const seqs = [];
  for await (const e of run.trace({ after: 5, follow: false })) seqs.push(e.seq);
  assert.equal(seqs.length, 501);
  assert.equal(seqs[0], 6);
  assert.equal(seqs[500], 506);
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[1].url).searchParams.get('after'), '5');
  assert.equal(new URL(calls[2].url).searchParams.get('after'), '505');
  for (const c of calls.slice(1)) assert.equal(new URL(c.url).pathname, '/api/v1/agent/a14/trace');
});

test('AgentRun.trace stops quietly on a 410', async () => {
  const gone = () => ({ status: 410, body: { error: 'this agent run has expired', code: 'expired' } });
  const { arc, calls } = client([
    { status: 202, body: agentRun('a15', 'running') },
    { body: agentRun('a15', 'running') },
    { body: { data: [step(1)], last: 1 } },
    gone(),
    gone(),
  ]);
  const run = await arc.agent('find it');
  const seqs = [];
  for await (const e of run.trace({ pollMs: 1 })) seqs.push(e.seq);
  assert.deepEqual(seqs, [1]);
  assert.equal(calls.length, 4);
  const once = [];
  for await (const e of run.trace({ follow: false })) once.push(e);
  assert.deepEqual(once, []);
  assert.equal(calls.length, 5);
  assert.equal(new URL(calls[4].url).pathname, '/api/v1/agent/a15/trace');
});

test('agent sends webhook and connectionId, and the run carries the webhook secret once', async () => {
  const { arc, calls } = client([
    { status: 202, body: agentRun('a16', 'queued', { webhookSecret: 'whsec_a' }) },
    { status: 202, body: agentRun('a17', 'queued') },
  ]);
  const hook = { url: 'https://hooks.test/agent', events: ['agent.completed'], metadata: { job: 7 } };
  const run = await arc.agent('find it', { webhook: hook, connectionId: 'conn_1' });
  assert.deepEqual(calls[0].body, { prompt: 'find it', webhook: hook, connectionId: 'conn_1' });
  assert.equal(run.webhookSecret, 'whsec_a');
  const plain = await arc.agent('find it', { webhook: 'https://hooks.test/plain' });
  assert.deepEqual(calls[1].body, { prompt: 'find it', webhook: 'https://hooks.test/plain' });
  assert.equal(plain.webhookSecret, '');
});

test('AgentRun exposes fieldSources and the continuation links, with defaults when absent', async () => {
  const fieldSources = { 'plans[0].price': { url: 'https://a.test/pricing', pageId: 'p1' }, '[2].name': { url: 'https://a.test/', pageId: 'p2' } };
  const { arc } = client([
    { body: agentRun('a18', 'done', { fieldSources, continuesRunId: 'a0', continuedBy: null, next: null }) },
    { body: agentRun('a19', 'credit_limit', { continuedBy: 'a20', next: null }) },
  ]);
  const run = await arc.getAgent('a18');
  assert.deepEqual(run.fieldSources, fieldSources);
  assert.equal(run.continuesRunId, 'a0');
  assert.equal(run.continuedBy, null);
  const old = await arc.getAgent('a19');
  assert.deepEqual(old.fieldSources, {});
  assert.equal(old.continuesRunId, null);
  assert.equal(old.continuedBy, 'a20');
});

test('AgentRun.continue POSTs /agent/{id}/continue and resolves a handle on the new run', async () => {
  const { arc, calls } = client([
    { body: agentRun('a 21', 'credit_limit', { data: { partial: 'half' }, next: null }) },
    { status: 202, body: agentRun('a22', 'queued', { continuesRunId: 'a 21', threadId: 'a 21' }) },
    { status: 202, body: agentRun('a23', 'queued', { continuesRunId: 'a 21' }) },
  ]);
  const stopped = await arc.getAgent('a 21');
  const before = stopped.envelope;
  const next = await stopped.continue({ maxCredits: 800, maxSteps: 20, apiTimeoutS: 500, idempotencyKey: 'cont-1' });
  assert.ok(next instanceof AgentRun);
  assert.equal(next.id, 'a22');
  assert.equal(next.status, 'queued');
  assert.equal(next.continuesRunId, 'a 21');
  assert.equal(next.envelope.threadId, 'a 21');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, 'https://api.mesharc.dev/api/v1/agent/a%2021/continue');
  assert.deepEqual(calls[1].body, { maxCredits: 800, maxSteps: 20, timeout: 120 });
  assert.equal(calls[1].headers['Idempotency-Key'], 'cont-1');
  assert.equal(stopped.envelope, before);
  await stopped.continue({ apiTimeoutS: 0 });
  assert.deepEqual(calls[2].body, {});
  assert.equal(calls[2].headers['Idempotency-Key'], undefined);
});

test('AgentRun.continue passes a 409 conflict, a 410 expired and a 404 through, and is not retried', async () => {
  const { arc, calls } = client([
    { body: agentRun('a24', 'done', { next: null }) },
    { status: 409, body: { error: 'only a run stopped at its credit limit can be continued; this one is done', code: 'conflict', request_id: 'req_c' } },
    { status: 410, body: { error: 'this run is past its keep date; its saved progress is gone', code: 'expired' } },
    { status: 404, body: { error: 'agent run not found', code: 'not_found' } },
  ]);
  const run = await arc.getAgent('a24');
  await assert.rejects(run.continue(), err => {
    assert.ok(err instanceof MeshArcError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'conflict');
    assert.equal(err.requestId, 'req_c');
    assert.match(String(err.detail), /credit limit/);
    return true;
  });
  await assert.rejects(run.continue(), err => err instanceof MeshArcError && err.status === 410 && err.code === 'expired');
  await assert.rejects(run.continue(), err => err instanceof MeshArcError && err.status === 404 && err.code === 'not_found');
  assert.equal(calls.length, 4);
});

test('AgentRun.continue keeps the stopped run\'s webhookSecret; the continue answer carries none', async () => {
  const { arc, calls } = client([
    { status: 202, body: agentRun('a25', 'queued', { webhookSecret: 'whsec_c' }) },
    { body: agentRun('a25', 'credit_limit', { data: { partial: 'half' }, next: null }) },
    { status: 202, body: agentRun('a26', 'queued', { continuesRunId: 'a25', threadId: 'a25' }) },
    { status: 202, body: agentRun('a27', 'queued', { continuesRunId: 'a26', threadId: 'a25' }) },
    { body: agentRun('a28', 'credit_limit', { next: null }) },
    { status: 202, body: agentRun('a29', 'queued', { continuesRunId: 'a28' }) },
  ]);
  const run = await arc.agent('find it', { webhook: 'https://hooks.test/agent' });
  await run.wait({ pollMs: 1 });
  assert.equal(run.status, 'credit_limit');
  const next = await run.continue();
  assert.equal(next.envelope.webhookSecret, undefined);
  assert.equal(next.webhookSecret, 'whsec_c');
  const third = await next.continue();
  assert.equal(third.webhookSecret, 'whsec_c');
  // A handle read back with getAgent never saw the secret, so neither does its continuation.
  const read = await arc.getAgent('a28');
  assert.equal(read.webhookSecret, '');
  assert.equal((await read.continue()).webhookSecret, '');
  assert.equal(calls.length, 6);
});

test('AgentRun.continue with an idempotency key is retried on a 503 and resends the same key', async () => {
  const { arc, calls } = client([
    { body: agentRun('a30', 'credit_limit', { next: null }) },
    { status: 503, body: { error: 'unavailable', code: 'unavailable' }, headers: { 'Retry-After': '0' } },
    { status: 202, body: agentRun('a31', 'queued', { continuesRunId: 'a30' }) },
  ]);
  const stopped = await arc.getAgent('a30');
  const next = await stopped.continue({ maxCredits: 300, idempotencyKey: 'cont-2' });
  assert.equal(next.id, 'a31');
  assert.equal(calls.length, 3);
  for (const c of calls.slice(1)) {
    assert.equal(c.method, 'POST');
    assert.equal(c.url, 'https://api.mesharc.dev/api/v1/agent/a30/continue');
    assert.equal(c.headers['Idempotency-Key'], 'cont-2');
    assert.deepEqual(c.body, { maxCredits: 300 });
  }
});

test('agentRuns with an invalid Date throws a TypeError before any request', async () => {
  const { arc, calls } = client([]);
  await assert.rejects(async () => {
    for await (const r of arc.agentRuns({ since: new Date('not a date') })) assert.fail(`unexpected row ${r.id}`);
  }, err => err instanceof TypeError && !(err instanceof MeshArcError) && err.message === 'since: an invalid Date');
  await assert.rejects(async () => {
    for await (const r of arc.agentRuns({ since: '2026-10-01', until: new Date(NaN) })) assert.fail(`unexpected row ${r.id}`);
  }, err => err instanceof TypeError && err.message === 'until: an invalid Date');
  assert.equal(calls.length, 0);
});

test('agentRuns sends model, since and until on every page, a Date as its ISO string', async () => {
  const { arc, calls } = client([
    { body: { data: [{ id: 'a' }], next: '/api/v1/agent?limit=1&cursor=1&model=openai%3Agpt-5.4-mini' } },
    { body: { data: [{ id: 'b' }], next: null } },
  ]);
  const since = new Date('2026-10-01T00:00:00Z');
  const ids = [];
  for await (const row of arc.agentRuns({ model: 'openai:gpt-5.4-mini', since, until: '2026-10-08', limit: 1 })) ids.push(row.id);
  assert.deepEqual(ids, ['a', 'b']);
  assert.equal(calls.length, 2);
  for (const [i, c] of calls.entries()) {
    const u = new URL(c.url);
    assert.equal(u.pathname, '/api/v1/agent');
    assert.equal(u.searchParams.get('model'), 'openai:gpt-5.4-mini');
    assert.equal(u.searchParams.get('since'), '2026-10-01T00:00:00.000Z');
    assert.equal(u.searchParams.get('until'), '2026-10-08');
    assert.equal(u.searchParams.get('status'), null);
    assert.equal(u.searchParams.get('limit'), '1');
    assert.equal(u.searchParams.get('cursor'), i === 0 ? null : '1');
  }
});

test('webSearch news sends sources ["news"] and page; news hits carry publisher and age', async () => {
  const news = searchDone('s11', { data: [{ position: 11, url: 'https://n.test/a', title: 'N', snippet: '', source: 'news', engine: 'google', publisher: 'The Paper', age: '20h' }] });
  const { arc, calls } = client([{ body: news }, { body: searchDone('s12') }]);
  const out = await arc.webSearch('mesh', { news: true, page: 2 });
  assert.deepEqual(calls[0].body, { query: 'mesh', sources: ['news'], page: 2, timeout: 60 });
  assert.equal(out.data[0].source, 'news');
  assert.equal(out.data[0].publisher, 'The Paper');
  assert.equal(out.data[0].age, '20h');
  await arc.webSearch('mesh', { news: false });
  assert.deepEqual(calls[1].body, { query: 'mesh', timeout: 60 });
});

const monitorRun = (id, extra = {}) => ({
  id, monitorId: 'm1', kind: 'search', trigger: 'manual', status: 'running', refId: 's1', credits: 0, answered: false, changed: false,
  summary: '', diff: null, error: '', createdAt: '2026-10-08T00:00:00Z', finishedAt: null, ...extra,
});

const monitor = (id, extra = {}) => ({
  id, kind: 'search', name: 'mesh', request: { query: 'mesh', limit: 10, sources: ['web'] }, schedule: 'daily', status: 'active',
  webhook: null, nextRunAt: '2026-10-09T00:00:00Z', lastRunAt: '2026-10-08T00:00:00Z', lastRun: monitorRun('r0', { trigger: 'first' }),
  createdAt: '2026-10-08T00:00:00Z', ...extra,
});

test('the monitors are a namespace beside projects and runs; monitor() is still the job queue', async () => {
  const { arc, calls } = client([{ body: { queued: 0, running: 1 } }]);
  for (const name of ['create', 'list', 'get', 'update', 'pause', 'resume', 'run', 'runs', 'delete']) {
    assert.equal(typeof arc.monitors[name], 'function', name);
  }
  for (const gone of ['createMonitor', 'getMonitor', 'updateMonitor', 'pauseMonitor', 'resumeMonitor', 'runMonitor', 'monitorRuns', 'deleteMonitor']) {
    assert.equal(arc[gone], undefined, gone);
  }
  assert.deepEqual(await arc.monitor(), { queued: 0, running: 1 });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/me/monitor');
});

test('monitors.create POSTs kind, request, schedule and the options given, and resolves the monitor with its secret', async () => {
  const hook = { url: 'https://hooks.test/m', events: ['search.changed'] };
  const made = monitor('m1', { webhook: hook, webhookSecret: 'whsec_m' });
  const { arc, calls } = client([{ status: 201, body: made }, { status: 201, body: monitor('m2') }]);
  const out = await arc.monitors.create('search', { query: 'mesh', sources: ['news'] }, 'daily', { name: 'Mesh news', webhook: hook, baselineId: 's1', idempotencyKey: 'mon-1' });
  assert.deepEqual(out, made);
  assert.equal(out.webhookSecret, 'whsec_m');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/monitors');
  assert.deepEqual(calls[0].body, { kind: 'search', request: { query: 'mesh', sources: ['news'] }, schedule: 'daily', name: 'Mesh news', webhook: hook, baselineId: 's1' });
  assert.equal(calls[0].headers['Idempotency-Key'], 'mon-1');
  await arc.monitors.create('agent', { prompt: 'find it' }, 'weekly');
  assert.deepEqual(calls[1].body, { kind: 'agent', request: { prompt: 'find it' }, schedule: 'weekly' });
  assert.equal(calls[1].headers['Idempotency-Key'], undefined);
});

test('monitors.create with an idempotency key is retried on a 503 and resends the same key and body', async () => {
  const { arc, calls } = client([
    { status: 503, body: { error: 'unavailable', code: 'unavailable' }, headers: { 'Retry-After': '0' } },
    { status: 201, body: monitor('m1') },
  ]);
  const out = await arc.monitors.create('search', { query: 'mesh' }, 'daily', { idempotencyKey: 'mon-2' });
  assert.equal(out.id, 'm1');
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.method, 'POST');
    assert.equal(c.url, 'https://api.mesharc.dev/api/v1/monitors');
    assert.equal(c.headers['Idempotency-Key'], 'mon-2');
    assert.deepEqual(c.body, { kind: 'search', request: { query: 'mesh' }, schedule: 'daily' });
  }
  const once = client([{ status: 503, body: { error: 'unavailable' } }, { status: 201, body: monitor('m2') }]);
  await assert.rejects(once.arc.monitors.create('search', { query: 'mesh' }, 'daily'), err => err instanceof MeshArcError && err.status === 503);
  assert.equal(once.calls.length, 1);
});

test('monitors.create passes a 400 and a baseline 404 through as MeshArcError', async () => {
  const { arc, calls } = client([
    { status: 400, body: { error: 'request: a monitored search reads its results page only; leave out scrape' } },
    { status: 404, body: { error: 'baselineId: this workspace has no search with that id' } },
  ]);
  await assert.rejects(arc.monitors.create('search', { query: 'mesh', scrape: { formats: ['markdown'] } }, 'daily'),
    err => err instanceof MeshArcError && err.status === 400 && /leave out scrape/.test(String(err.detail)));
  await assert.rejects(arc.monitors.create('search', { query: 'mesh' }, 'daily', { baselineId: 'nope' }),
    err => err instanceof MeshArcError && err.status === 404);
  assert.equal(calls.length, 2);
});

test('monitors.list lists with kind, or with no query string; monitors.get reads one and passes a 404 through', async () => {
  const { arc, calls } = client([
    { body: { data: [monitor('m1'), monitor('m2', { kind: 'agent' })] } },
    { body: { data: [monitor('m3', { kind: 'agent' })] } },
    { body: monitor('m 4') },
    { status: 404, body: { error: 'monitor not found', code: 'not_found' } },
  ]);
  const all = await arc.monitors.list();
  assert.deepEqual(all.map(m => m.id), ['m1', 'm2']);
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/monitors');
  const agents = await arc.monitors.list({ kind: 'agent' });
  assert.deepEqual(agents.map(m => m.id), ['m3']);
  assert.equal(calls[1].url, 'https://api.mesharc.dev/api/v1/monitors?kind=agent');
  const one = await arc.monitors.get('m 4');
  assert.equal(one.id, 'm 4');
  assert.equal(one.lastRun.trigger, 'first');
  assert.equal(calls[2].method, 'GET');
  assert.equal(calls[2].url, 'https://api.mesharc.dev/api/v1/monitors/m%204');
  await assert.rejects(arc.monitors.get('gone'), err => {
    assert.ok(err instanceof MeshArcError);
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
    return true;
  });
});

test('monitors.update PATCHes the fields given; monitors.pause and monitors.resume POST their routes', async () => {
  const { arc, calls } = client([
    { body: monitor('m1', { schedule: 'hourly', webhookSecret: 'whsec_n' }) },
    { body: monitor('m1', { webhook: null }) },
    { body: monitor('m1', { status: 'paused', nextRunAt: null }) },
    { body: monitor('m1') },
    { status: 400, body: { error: 'schedule must be one of hourly, daily, weekly' } },
  ]);
  const changed = await arc.monitors.update('m1', { name: 'Renamed', schedule: 'hourly', webhook: 'https://hooks.test/n' });
  assert.equal(changed.webhookSecret, 'whsec_n');
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/monitors/m1');
  assert.deepEqual(calls[0].body, { name: 'Renamed', schedule: 'hourly', webhook: 'https://hooks.test/n' });
  await arc.monitors.update('m1', { webhook: '' });
  assert.deepEqual(calls[1].body, { webhook: '' });
  const paused = await arc.monitors.pause('m1');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.nextRunAt, null);
  assert.equal(calls[2].method, 'POST');
  assert.equal(calls[2].url, 'https://api.mesharc.dev/api/v1/monitors/m1/pause');
  assert.equal(calls[2].body, undefined);
  const resumed = await arc.monitors.resume('m1');
  assert.equal(resumed.status, 'active');
  assert.equal(calls[3].method, 'POST');
  assert.equal(calls[3].url, 'https://api.mesharc.dev/api/v1/monitors/m1/resume');
  await assert.rejects(arc.monitors.update('m1', { schedule: 'monthly' }), err => err instanceof MeshArcError && err.status === 400);
});

test('monitors.pause and monitors.resume pass a 404 through, and are not retried', async () => {
  const { arc, calls } = client([
    { status: 404, body: { error: 'monitor not found', code: 'not_found', request_id: 'req_p' } },
    { status: 404, body: { error: 'monitor not found', code: 'not_found' } },
  ]);
  await assert.rejects(arc.monitors.pause('gone'), err => {
    assert.ok(err instanceof MeshArcError);
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
    assert.equal(err.requestId, 'req_p');
    return true;
  });
  await assert.rejects(arc.monitors.resume('gone'), err => err instanceof MeshArcError && err.status === 404 && err.code === 'not_found');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/monitors/gone/pause');
  assert.equal(calls[1].url, 'https://api.mesharc.dev/api/v1/monitors/gone/resume');
});

test('monitors.run POSTs /run and resolves the run; a 409 while one is under way and a 404 pass through', async () => {
  const { arc, calls } = client([
    { status: 202, body: monitorRun('r1') },
    { status: 409, body: { error: 'a run of this monitor is under way', code: 'conflict' } },
    { status: 404, body: { error: 'monitor not found', code: 'not_found' } },
  ]);
  const run = await arc.monitors.run('m1', { idempotencyKey: 'run-1' });
  assert.equal(run.id, 'r1');
  assert.equal(run.status, 'running');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/monitors/m1/run');
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].headers['Idempotency-Key'], 'run-1');
  await assert.rejects(arc.monitors.run('m1'), err => {
    assert.ok(err instanceof MeshArcError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'conflict');
    assert.equal(err.detail, 'a run of this monitor is under way');
    return true;
  });
  await assert.rejects(arc.monitors.run('gone'), err => err instanceof MeshArcError && err.status === 404 && err.code === 'not_found');
  assert.equal(calls.length, 3);
});

test('monitors.runs pages with limit re-sent and follows the cursor; a 404 passes through', async () => {
  const diff = { baseline: false, withheld: '', comparable: true, new: [{ url: 'https://b.test/' }], dropped: [], moved: [], changed: true, summary: '1 new' };
  const { arc, calls } = client([
    { body: { data: [monitorRun('r2', { status: 'done', answered: true, changed: true, summary: '1 new', diff }), monitorRun('r1', { status: 'done' })], next: '/api/v1/monitors/m%201/runs?limit=2&cursor=2' } },
    { body: { data: [monitorRun('r0', { trigger: 'first' })], next: null } },
    { status: 404, body: { error: 'monitor not found', code: 'not_found' } },
  ]);
  const rows = [];
  for await (const r of arc.monitors.runs('m 1', { limit: 2 })) rows.push(r);
  assert.deepEqual(rows.map(r => r.id), ['r2', 'r1', 'r0']);
  assert.deepEqual(rows[0].diff, diff);
  assert.equal(calls.length, 2);
  const first = new URL(calls[0].url);
  assert.equal(first.pathname, '/api/v1/monitors/m%201/runs');
  assert.equal(first.searchParams.get('limit'), '2');
  assert.equal(first.searchParams.get('cursor'), null);
  const second = new URL(calls[1].url);
  assert.equal(second.searchParams.get('limit'), '2');
  assert.equal(second.searchParams.get('cursor'), '2');
  await assert.rejects(async () => {
    for await (const r of arc.monitors.runs('gone')) assert.fail(`unexpected row ${r.id}`);
  }, err => err instanceof MeshArcError && err.status === 404);
});

test('monitors.delete sends DELETE and resolves the API answer; a 404 passes through', async () => {
  const { arc, calls } = client([
    { body: { id: 'm1', deleted: true } },
    { status: 404, body: { error: 'monitor not found', code: 'not_found' } },
  ]);
  assert.deepEqual(await arc.monitors.delete('m1'), { id: 'm1', deleted: true });
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.mesharc.dev/api/v1/monitors/m1');
  await assert.rejects(arc.monitors.delete('gone'), err => err instanceof MeshArcError && err.status === 404 && err.code === 'not_found');
  assert.equal(calls.length, 2);
});
