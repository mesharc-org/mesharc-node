import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { MeshArc, MeshArcError, MeshArcTimeoutError, VERSION } from '../dist/index.js';

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
