# mesharc

The Node client for the [MeshArc](https://mesharc.dev) API: a URL in, clean content out, and a record of what changed.

- **Scrape** one page or a batch — markdown, text, HTML, links, structured fields, a screenshot.
- **Crawl** a whole site with no project to set up first, and keep it as one if it turns out to be worth watching.
- **Map** what a site declares in its sitemaps before fetching any of it.
- **Search** the web: results for a query, and their pages read too if you ask.
- **Ask** the agent: a prompt in, an answer out — as JSON matching your schema — with the pages it drew on.
- **Monitor** a search or a question: asked again on a schedule, and told when the answer changes.
- **Watch** a site over time: projects, scheduled runs, and a change record — pages added, removed, modified, field by field.

Zero dependencies. Node 20 or newer. TypeScript types included; ESM and CommonJS builds.

## Install

```bash
npm install mesharc
```

## Authentication

Every call needs an API key. Create one in the app under **Settings → API keys** — it is shown once — and give it to the client, or put it in `MESHARC_API_KEY` and construct the client with nothing:

```ts
import { MeshArc } from 'mesharc';

const arc = new MeshArc('mesharc_...');
// or, with MESHARC_API_KEY in the environment:
const arc = new MeshArc();
// options: new MeshArc({ apiKey, timeoutMs: 150_000, maxRetries: 2 })
```

The key is only ever sent as a bearer header to `api.mesharc.dev`. Keep it on the server: a key in browser code is a key anyone can read.

A key carries the scopes it was made with (`read`, `write`, `admin`), optionally a set of projects it may see, an expiry and a rate limit. A route the key may not use answers `403`; a project it may not see answers `404`.

## Quick start

```ts
import { MeshArc } from 'mesharc';

const arc = new MeshArc('mesharc_...');

const page = await arc.scrape('https://example.com/pricing');
console.log(page.markdown);
console.log(page.verdict, page.method, page.credits);   // 'ok' 'crawler' 1
```

`scrape` holds the request open until the page comes back (60 s by default), so there is nothing to poll for an ordinary page.

## Reading pages

### One page

```ts
const page = await arc.scrape('https://quotes.toscrape.com/js/', { render_js: 'always' });
```

The second argument is a config: any setting a project takes, by its API name (`render_js`, `only_main_content`, `formats`, `max_tier`, `wait_for_selector`, `actions`, …). The full list, with defaults, is at [mesharc.dev/docs/configuration](https://mesharc.dev/docs/configuration).

```ts
const page = await arc.scrapeOne('https://example.com/', undefined, {
  formats: 'markdown,text,cleanHtml',   // which bodies to return
  apiTimeoutS: 120,                     // how long the API holds the request (120 max)
  idempotencyKey: 'pricing-2026-09-18', // the same key returns the first answer for 24 h
});
```

### Many pages

A list of URLs is a batch: grouped by host, fetched in parallel where the config allows, and returned as one row per URL.

```ts
const batch = await arc.scrape(['https://a.com/', 'https://b.com/x'], { concurrency: 4 });
for (const row of batch.pages) console.log(row.url, row.httpStatus, row.verdict, row.credits);
```

`scrape(urls, config, { wait: false })` returns the batch id at once; `arc.batch(id, { wait: true })` finishes it later. Pass `webhookUrl` to be told instead of polling (`batch.finished`, signed with a secret returned once).

### What a page looks like

Every page row carries the same fields, whether it came from a scrape, a crawl or a project:

| Field | Meaning |
|---|---|
| `markdown`, `text`, `cleanHtml`, `html`, `links`, `fields`, `screenshot` | The bodies you asked for |
| `httpStatus` | The status the site answered with |
| `verdict` | `ok`, `thin` (short, but a page), `blocked` (refused, or a 404), `skipped` |
| `errorCode` | `OK`, or what went wrong: `BLOCKED`, `NOT_FOUND`, `TIER_LIMIT`, `CAPTCHA`, `LOGIN_REQUIRED`, `RATE_LIMITED`, `TIMEOUT` … |
| `shape`, `warnings`, `signals` | `listing` / `table` / `form` for a short page whose markup says what it is; `short`; why the judge decided as it did |
| `method`, `tier`, `climbedTo` | The engine that read it (`crawler`, `tls`, `minted`, `browser`, `browser-residential`, …), its tier, and how far a refused page climbed |
| `credits`, `billedAs` | What it cost; the rung it is priced at when not the one that fetched it |
| `words`, `language`, `head`, `reason`, `crawledAt` | Size, language, the head fields, the judge's sentence, when |

A page the site refused costs 0, and so does a 404.

## Crawling a site

```ts
const job = await arc.crawl('https://docs.example.com', {
  limit: 200,                       // page budget
  maxDepth: 3,                      // link hops from the seed
  includePaths: ['/docs/*'],
  crawlMode: 'sitemap_first',       // what the sitemap declares first, then links
  maxTier: 'browser',               // how far a refused page may climb
  scrapeOptions: { formats: ['markdown', 'links'] },
  config: { crawl_delay_ms: 500 },  // any project setting, directly
});

for await (const page of job.pages()) console.log(page.url, page.words);   // follows the cursor while the crawl runs
console.log(job.status, job.envelope.counts, job.envelope.creditsUsed);
```

`crawl` returns a handle immediately; `job.pages()` yields pages as they land and ends when the crawl does. `{ wait: true }` blocks until it finishes; `job.wait()`, `job.refresh()`, `job.cancel()` do what they say; `arc.getCrawl(id)` reattaches to a crawl started elsewhere.

A one-shot crawl expires after 30 days. If the site is worth watching:

```ts
const project = await job.keep({ name: 'Docs', schedule: 'weekly' });
```

A `webhook` in the options (`{ url, events, metadata }`) is told about `crawl.started`, `crawl.page` (fifty pages a message) and `crawl.completed`; its signing secret comes back once as `job.webhookSecret`.

## Mapping a site

```ts
for (const u of await arc.map('https://docs.example.com')) console.log(u.url, u.lastmod);

const details = await arc.mapDetails('https://www.gov.uk/', { search: 'visa', limit: 500 });
console.log(details.totals, details.creditsUsed);   // { files: 29, urls: 508431, … } 29
```

A map costs one credit per sitemap file read — most sites are one file.

## Searching the web

```ts
const out = await arc.webSearch('node fetch retry', {
  limit: 5,                                  // 1 to 10 results
  freshness: 'month',                        // 'hour' | 'day' | 'week' | 'month' | 'year'
  includeDomains: ['github.com', 'nodejs.org'],
  scrape: true,                              // read each result's page too, as markdown
});

if (out.status === 'blocked') console.log('every engine refused', out.attempts);
for (const hit of out.data) console.log(hit.position, hit.url, hit.title, hit.engine, hit.page?.markdown);
console.log(out.cached, out.creditsUsed);
```

`webSearch` waits for the search to finish and resolves to it: `queued` and `running` are polled, `done` and `blocked` (every engine refused the results page) resolve, and `error` throws `MeshArcError`. `country`, `lang` and `excludeDomains` narrow the results further; `scrape` also takes `{ formats, maxCredits }`. `{ wait: false }` returns the search at once; `arc.getSearch(id)` reads it as it stands now.

```ts
const news = await arc.webSearch('mesharc', { news: true, page: 2 });   // the news results, 11 to 20
for (const hit of news.data) console.log(hit.position, hit.publisher, hit.age, hit.title);   // 11 'The Paper' '20h' …
```

`news: true` reads the engines' news results instead of the web ones (`source: 'news'`), each with its `publisher` and `age` as the engine put it. `page` (1 to 10) reads further in: page 2 is results 11 to 20, and each page is its own search. `news` and `page` need an API with those features: they are on the API's feature branch, not yet on mesharc.dev.

```ts
for await (const s of arc.searches({ q: 'retry', limit: 50 })) console.log(s.id, s.query, s.status, s.resultCount, s.creditsUsed);
```

`searches` yields the workspace's web searches, newest first, following the cursor; `q` keeps those whose query contains it.

A web search needs a key that can write, and spends credits. A results page every engine refused is free. An equal search — the same query, news or web, page, country, lang, freshness and domains — within an hour of a finished one (ten minutes for news) comes from the cache (`cached: true`) with no charge for the results page. A page read with `scrape` is always charged, as a scrape.

`search()` is something else: it looks inside a project's pages (see below).

## Asking the agent

The agent takes a prompt, searches, reads pages and answers. It needs an API with the `/agent` route, which is not live on mesharc.dev yet (web search is). Its `webhook`, `connectionId`, `continue()` and `fieldSources` need an API with those features too: they are on the API's feature branch, not yet on mesharc.dev.

```ts
const run = await arc.agent('Which plans does example.com offer, and at what price?', {
  urls: ['https://example.com/pricing'],      // pages to start from (20 at most)
  schema: {                                   // the answer under data matches it
    type: 'object',
    properties: { plans: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'string' } } } } },
  },
  maxCredits: 500,                            // 1 to 100,000 (2,000 by default)
});

await run.wait();                             // done, cancelled or credit_limit
console.log(run.status, run.data, run.envelope.creditsUsed);
for (const s of run.sources) console.log(s.url, s.title);
```

`agent` resolves to an `AgentRun` at once — or, with `apiTimeoutS` (120 at most), once the run finishes or that time passes. `run.wait()` polls while the run is `queued` or `running` and resolves once it is `done`, `cancelled` or `credit_limit`; `error` throws `MeshArcError` 502 `job_failed`. `run.refresh()` reads it as it stands now; `arc.getAgent(id)` reattaches to a run started elsewhere. `maxSteps` (1 to 100, 40 by default) caps the steps and `allowedDomains` (20 at most) the sites it may read; a prompt is up to 10,000 characters.

The answer is JSON matching `schema` — a JSON Schema whose type is `object` or `array` — and `{ text }` without one. `run.fieldSources` says where each value came from, by its path in the answer: `{ 'plans[0].price': { url, pageId } }` (`'[2].name'` for a list answer).

A run that reaches `maxCredits` stops with status `credit_limit` and what it had as `{ partial }`. `continue()` carries it on with a new budget:

```ts
if (run.status === 'credit_limit') {
  const more = await run.continue({ maxCredits: 1_000 });   // a new run on the same thread
  await more.wait();
  console.log(more.continuesRunId === run.id, more.data);   // true, the full answer
}
```

The new run resumes where the stopped one was and keeps the pages it read, which are not paid for again; `maxCredits` and `maxSteps` are the stopped run's when left out, and `apiTimeoutS` (120 at most) holds the request open for the answer. It posts to the stopped run's webhook, signed with the same secret, so `more.webhookSecret` is `run.webhookSecret`. The stopped run's `continuedBy` names the new one once `refresh()` reads it. A run that did not stop at its limit, was already continued or has no saved progress throws `MeshArcError` 409 with code `conflict`; one past its keep date, 410 `expired`; one whose LLM connection can no longer be used, 400.

`webhook` — a URL, or `{ url, events, metadata }` — is told of the run's life (`agent.started`, `agent.action`, `agent.completed`, `agent.failed`, `agent.cancelled`); its signing secret comes back once as `run.webhookSecret`. `connectionId` runs the agent on one of the workspace's own LLM connections: its model, on its key.

```ts
for await (const step of run.trace()) console.log(step.seq, step.kind, step.text);   // follows the run while it works

const { status } = await run.cancel();   // 'cancelled' if it was queued, 'cancelling' if it was running
```

`trace()` yields the run's steps (`start`, `model`, `search`, `fetch`, …) oldest first and ends when the run does; `{ follow: false }` returns what exists, `{ after: seq }` starts later. A running run stops before its next step, and what it already used stays charged; `cancel()` leaves `run.envelope` as it was, so `refresh()` reads the outcome.

```ts
for await (const r of arc.agentRuns({ status: 'done', limit: 50 })) console.log(r.id, r.prompt, r.steps, r.creditsUsed);
for await (const r of arc.agentRuns({ model: 'openai:gpt-5.4-mini', since: new Date('2026-10-01'), until: '2026-10-08' })) console.log(r.id);
```

`agentRuns` yields the workspace's agent runs, newest first, following the cursor. `status` keeps one status (`queued`, `running`, `done`, `error`, `cancelled`, `credit_limit` or `expired`), `model` one model's runs (by the name runs show it under), and `since` / `until` the runs made from / before an ISO 8601 date or date-time — a `Date` is sent as its ISO string, and an invalid `Date` throws a `TypeError` before any request.

An agent run needs a key that can write. It is charged each page as it reads it (a refused page is free) and the model's tokens at the model provider's price plus 20% — or 1 credit per 1,000 tokens on the workspace's own connection (`connectionId`). A run and its trace are kept 7 days; after that `getAgent` throws `MeshArcError` 410 with code `expired`, and `trace()` ends quietly.

## Monitors: a search or a question, asked again on a schedule

A monitor keeps a web search or an agent request and runs it hourly, daily or weekly; each run is compared with the last one that answered, and a webhook hears when something changed. Monitors need an API with the `/monitors` route: it is on the API's feature branch, not yet on mesharc.dev.

```ts
const mon = await arc.monitors.create('search', { query: 'mesharc', sources: ['news'] }, 'daily', {
  name: 'MeshArc in the news',
  webhook: 'https://example.com/hooks/mesharc',   // told search.changed; the secret is mon.webhookSecret, once
});

for await (const r of arc.monitors.runs(mon.id)) console.log(r.createdAt, r.status, r.changed, r.summary);
```

`arc.monitors.create(kind, request, schedule, opts)` takes `'search'` or `'agent'`, the request, and `'hourly'`, `'daily'` or `'weekly'`. The request is the body of a `POST /search` or `POST /agent`, by the API's own names, and is typed for each kind:

- `'search'` takes a `SearchMonitorRequest`: `query`, `limit`, `sources`, `page`, `country`, `lang`, `freshness`, `includeDomains`, `excludeDomains`. A news monitor is `sources: ['news']` — not `news: true`, which is a `webSearch` option and a type error here. There is no `scrape`: a monitored search reads its results page only.
- `'agent'` takes an `AgentMonitorRequest`: `prompt`, `urls`, `schema`, `maxCredits`, `maxSteps`, `allowedDomains`, `connectionId`.

`opts` takes `name` (the query or prompt when left out; at most 120 characters), `webhook`, `baselineId` and `idempotencyKey`. `baselineId` — a finished search or agent run with the same request — is the first run and is not paid for again; without it the first run starts now. A search baseline's `limit` must be at least the monitor's. `webhook` (a URL, or `{ url, events, metadata }`) hears `search.changed` or `agent.changed`, and its signing secret is in the answer once, as `webhookSecret`.

| Method | What it does |
|---|---|
| `monitors.create(kind, request, schedule, { name, webhook, baselineId, idempotencyKey })` | Keep a search or an agent request; resolves to the monitor with its first run as `lastRun` |
| `monitors.list({ kind })` | The workspace's monitors, newest first, each with its `lastRun`; `kind` keeps the search or the agent ones |
| `monitors.get(id)` | One monitor, with its `lastRun` |
| `monitors.update(id, { name, schedule, status, webhook })` | Change it; `status` is `active` or `paused`, `webhook: ''` removes the webhook, and a new one's secret comes back once |
| `monitors.pause(id)` · `monitors.resume(id)` | Stop the scheduled runs (a run under way finishes); start them again, a missed slot running once |
| `monitors.run(id, { idempotencyKey })` | Run it now, paused or not; `MeshArcError` 409 `conflict` while a run is under way, 402 `credits_exhausted` when the credits are spent |
| `monitors.runs(id, { limit })` | Its runs, newest first, following the cursor: `trigger`, `status`, `refId` (the search or agent run it made), `credits`, `answered`, `changed`, `summary`, `diff` |
| `monitors.delete(id)` | The monitor and its runs; the searches and agent runs it made stay in the history, and an agent run under way is stopped |

A run's `diff` is, for a search, `{ baseline, withheld, comparable, new, dropped, moved, changed, summary }`, and for an agent run `{ baseline, withheld, changed, counts, changes, summary }`; `withheld` is the reason a run was not compared, `''` when it was.

Each run is an ordinary search or agent run, charged as one; a run that did not answer — a results page every engine refused, an agent run stopped at its credit limit — is kept and compared with nothing. `arc.monitors` is not `arc.monitor()`, which is the workspace's job queue: what is queued and running.

## Watching a site: projects and runs

```ts
const project = await arc.projects.create('https://docs.example.com', {
  name: 'Docs',
  schedule: 'weekly',                                   // 'manual' | 'hourly' | 'daily' | 'weekly'
  config: { max_pages: 300, include_paths: ['/docs/*'] },
});

const run = await arc.runs.start(project.id, { wait: true });   // the first run
// ...a week later, or arc.runs.start again: the second run produces the change record

const record = await arc.changes(project.id);
console.log(record.change.counts);   // { added, removed, modified, same, withheld, … }

const diff = await arc.pageDiff(project.id, 'https://docs.example.com/pricing');
```

| Method | What it does |
|---|---|
| `projects.list()` · `projects.get(id)` · `projects.update(id, { name, schedule, retention, config })` · `projects.delete(id)` | The projects |
| `runs.list(projectId)` · `runs.start(projectId, { wait })` · `runs.wait(projectId, runId)` · `runs.get(projectId, runId)` · `runs.cancel(projectId, runId)` | Runs |
| `pages(projectId, runId?)` · `page(projectId, url, runId?)` | The pages of a run; one page in full |
| `changes(projectId, runId?)` · `pageDiff(projectId, url, runId?)` | The change record; one page's word-level diff |
| `search(projectId, q, 'content' \| 'selector', runId?)` | Which pages say this (words, `"phrases"`) or contain this (CSS / XPath) |
| `recrawl(projectId, urls)` | Fetch these pages again, now |
| `sources(projectId)` | The seed, sitemap, URL list, feeds and patterns with what the last run found through each |
| `export(projectId, { dataset, format, runId, urls })` | A dataset (`pages`, `markdown`, `changes`, `fields`, `sitemap`, `rows`, `row-events`, `llms`, `llms-full`) as `jsonl`, `csv` or `txt` — returns the `Response`, stream it. The API refuses some pairs: `llms` and `llms-full` come only as `txt`, `txt` only for those two, and `markdown` only as `jsonl` |

```ts
const csv = await (await arc.export(project.id, { dataset: 'pages', format: 'csv' })).text();
```

## The workspace

```ts
const me = await arc.me();               // the workspace, its plan and limits, credits used and remaining, what this key may do
const usage = await arc.usage();         // pages per day, this month by engine
const monitor = await arc.monitor();     // the job queue: what is queued and running (not arc.monitors)
const meta = await arc.meta();           // verdict meanings, engine costs, the config defaults
const keys = await arc.keys();
const key = await arc.createKey('ci', { scopes: ['read', 'write'], projects: [project.id], expiresInDays: 90 });   // key.key, once
await arc.revokeKey(key.id);
```

## Errors

Every failure throws `MeshArcError`, a job the client stopped waiting for included:

```ts
import { MeshArc, MeshArcError } from 'mesharc';

try {
  await arc.crawl('https://example.com', { limit: 1_000_000 });
} catch (e) {
  if (e instanceof MeshArcError) console.log(e.status, e.code, e.detail, e.requestId);
}
```

| `code` | Status | Meaning |
|---|---|---|
| `validation` | 400 / 422 | Something in the request is wrong; `detail` says what |
| `unauthorized` | 401 | No key, or a revoked or expired one |
| `plan_limit` | 402 | The plan does not include this |
| `credits_exhausted` | 402 | The workspace's credits are spent |
| `forbidden` | 403 | The key's scopes do not allow it |
| `not_found` | 404 | No such thing — or not one this key may see |
| `conflict` | 409 | The request contradicts current state |
| `expired` | 410 | An agent run past its keep date (7 days) |
| `rate_limited` | 429 | Over the key's rate limit; `X-RateLimit-Reset` says when |
| `internal` | 500 | Quote `requestId` to support |

`requestId` is the id the API put on the response and in its own logs, so a support conversation starts from one string.

Two more cases, both with `status: 0`: a network failure or a request that hits `timeoutMs` throws `MeshArcError` with `code: 'network'` or `'timeout'`; a job the client stopped waiting for throws `MeshArcTimeoutError`, which is also a `MeshArcError` (`code: 'timeout'`) and carries `jobId` so you can poll it later (`arc.getCrawl(id)`, `arc.batch(id)`, `arc.getSearch(id)`, `arc.getAgent(id)`). Both timeouts have `code: 'timeout'`; tell them apart with `e instanceof MeshArcTimeoutError` or by `jobId`:

```ts
import { MeshArcError, MeshArcTimeoutError } from 'mesharc';

try {
  await arc.crawl('https://example.com', { wait: true, timeoutMs: 60_000 });
} catch (e) {
  if (e instanceof MeshArcTimeoutError) console.log('still running', e.jobId);   // check this first
  else if (e instanceof MeshArcError) console.log(e.status, e.code);
}
```

## Idempotency and timeouts

- `scrape`, `scrapeOne`, `crawl`, `webSearch`, `agent`, `run.continue`, `monitors.create` and `monitors.run` take `idempotencyKey`: send the same key again within 24 hours and you get the first answer back rather than a second job.
- Waiting calls take `{ wait, pollMs, timeoutMs }`; `wait: false` returns the envelope at once. By default a crawl, a project run and a batch scrape poll every 3 s for up to an hour; `extract` and `map` every 2 s for up to 5 minutes; `scrapeOne` and `webSearch` every 2 s for up to 10 minutes. An agent run's `wait()` and `trace()` take `{ pollMs, timeoutMs }` and poll every 2 s for up to an hour.
- Every HTTP request is aborted after `timeoutMs` (150 s by default) and retried on 429, 502, 503, 504 and network failures when it is safe to repeat — a GET, a DELETE, or a POST with an idempotency key — up to `maxRetries` times (2), honouring `Retry-After`.
- `apiTimeoutS` on a single scrape is how long the API itself holds the request open (60 s by default, 120 at most); a slower page comes back as an id and is polled.

## Credits

Every response says what it cost: `credits` on a page, `creditsUsed` on a job envelope, `X-MeshArc-Credits` on the HTTP response. A page costs the engine that read it — a plain fetch 1, a render 4 — and a refused page or a 404 costs nothing. An agent run also pays for the model's tokens, at the model provider's price plus 20% (1 credit per 1,000 tokens on the workspace's own connection). The schedule and the plans are at [mesharc.dev/docs/billing](https://mesharc.dev/docs/billing).

## Privacy and security

The client talks to one host — the API base URL, `https://api.mesharc.dev` unless `MESHARC_API_URL` or `baseUrl` says otherwise — and to nothing else. The key travels only as a bearer header, only over HTTPS. Nothing is written to disk, no telemetry is sent, and the only environment variables read are `MESHARC_API_KEY` and `MESHARC_API_URL`.

What MeshArc keeps about you and about the pages you crawl, and for how long, is in the [privacy policy](https://mesharc.dev/legal/privacy). How the service is secured is on the [security page](https://mesharc.dev/legal/security). To report a vulnerability in this client or in the service, write to security@mesharc.dev rather than opening a public issue — see [SECURITY.md](https://github.com/mesharc-org/mesharc-node/blob/main/SECURITY.md).

## Anything else

`arc.call(method, path, body?, params?)` makes any request to the API and returns its JSON; `arc.raw(...)` returns the `Response`. The full reference is at [mesharc.dev/docs/api](https://mesharc.dev/docs/api).

- Documentation: [mesharc.dev/docs](https://mesharc.dev/docs)
- Python client: `pip install mesharc` — [mesharc-python](https://github.com/mesharc-org/mesharc-python); it also ships the MCP server for agents
- Issues and pull requests: [mesharc-node](https://github.com/mesharc-org/mesharc-node)
- Questions: hello@mesharc.dev

MIT.
