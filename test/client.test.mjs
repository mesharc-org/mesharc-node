import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeshArc, MeshArcError, MeshArcTimeoutError, VERSION } from '../dist/index.js';

/** A fetch that answers from a script of responses and records what it was asked. */
function fakeFetch(script) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${init.method} ${url}`);
    if (next instanceof Error) throw next;
    const { status = 200, body = {}, headers = {} } = next;
    return new Response(status === 204 ? null : JSON.stringify(body), {
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
  await assert.rejects(arc.scrape('https://a.test/', undefined, { pollMs: 1, timeoutMs: 0 }), err => {
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
