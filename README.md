# mesharc

The Node client for the [MeshArc](https://mesharc.dev) API: a URL in, clean content out, and a record of what changed.

- **Scrape** one page or a batch — markdown, text, HTML, links, structured fields, a screenshot.
- **Crawl** a whole site with no project to set up first, and keep it as one if it turns out to be worth watching.
- **Map** what a site declares in its sitemaps before fetching any of it.
- **Watch** a site over time: projects, scheduled runs, and a change record — pages added, removed, modified, field by field.

Zero dependencies. Node 18 or newer. TypeScript types included; ESM and CommonJS builds.

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
| `export(projectId, { dataset, format, runId, urls })` | A dataset (`pages`, `markdown`, `changes`, `fields`, `sitemap`) as `jsonl` or `csv` — returns the `Response`, stream it |

```ts
const csv = await (await arc.export(project.id, { dataset: 'pages', format: 'csv' })).text();
```

## The workspace

```ts
const me = await arc.me();               // the workspace, its plan and limits, credits used and remaining, what this key may do
const usage = await arc.usage();         // pages per day, this month by engine
const monitor = await arc.monitor();     // what is queued and running
const meta = await arc.meta();           // verdict meanings, engine costs, the config defaults
const keys = await arc.keys();
const key = await arc.createKey('ci', { scopes: ['read', 'write'], projects: [project.id], expiresInDays: 90 });   // key.key, once
await arc.revokeKey(key.id);
```

## Errors

Every failure throws `MeshArcError`:

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
| `plan_limit` | 402 | The plan does not include this, or the credits are spent |
| `forbidden` | 403 | The key's scopes do not allow it |
| `not_found` | 404 | No such thing — or not one this key may see |
| `conflict` | 409 | The request contradicts current state |
| `rate_limited` | 429 | Over the key's rate limit; `X-RateLimit-Reset` says when |
| `internal` | 500 | Quote `requestId` to support |

`requestId` is the id the API put on the response and in its own logs, so a support conversation starts from one string.

Two more cases: a network failure or a request that hits `timeoutMs` throws `MeshArcError` with `status: 0` and `code: 'network'` or `'timeout'`; a job the client stopped waiting for throws `MeshArcTimeoutError`, which carries `jobId` so you can poll it later (`arc.getCrawl(id)`, `arc.batch(id)`).

## Idempotency and timeouts

- `scrape`, `scrapeOne` and `crawl` take `idempotencyKey`: send the same key again within 24 hours and you get the first answer back rather than a second job.
- Waiting calls take `{ wait, pollMs, timeoutMs }`. `wait: false` returns the envelope at once; the default polls every 3 s for up to an hour.
- Every HTTP request is aborted after `timeoutMs` (150 s by default) and retried on 429, 502, 503, 504 and network failures when it is safe to repeat — a GET, a DELETE, or a POST with an idempotency key — up to `maxRetries` times (2), honouring `Retry-After`.
- `apiTimeoutS` on a single scrape is how long the API itself holds the request open (60 s by default, 120 at most); a slower page comes back as an id and is polled.

## Credits

Every response says what it cost: `credits` on a page, `creditsUsed` on a job envelope, `X-MeshArc-Credits` on the HTTP response. A page costs the engine that read it — a plain fetch 1, a render 4 — and a refused page or a 404 costs nothing. The schedule and the plans are at [mesharc.dev/docs/billing](https://mesharc.dev/docs/billing).

## Anything else

`arc.call(method, path, body?, params?)` makes any request to the API and returns its JSON; `arc.raw(...)` returns the `Response`. The full reference is at [mesharc.dev/docs/api](https://mesharc.dev/docs/api).

- Documentation: [mesharc.dev/docs](https://mesharc.dev/docs)
- Python client: `pip install mesharc` — [mesharc-python](https://github.com/mesharc-org/mesharc-python); it also ships the MCP server for agents
- Issues and pull requests: [mesharc-node](https://github.com/mesharc-org/mesharc-node)
- Questions: hello@mesharc.dev

MIT.
