/**
 * mesharc — the Node client for the MeshArc API.
 *
 *   import { MeshArc } from 'mesharc';
 *   const arc = new MeshArc('mesharc_...');           // or new MeshArc() with MESHARC_API_KEY set
 *   const page = await arc.scrape('https://example.com/pricing');
 *
 * Every method is one API call (or a poll loop where `wait` applies) and
 * resolves to the API's JSON, so the API reference at
 * https://mesharc.dev/docs/api applies to every return value.
 */

export const VERSION = '0.2.0';

const DEFAULT_BASE = 'https://api.mesharc.dev';
const DEFAULT_TIMEOUT_MS = 150_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** A request the API refused, or a response that was not a page. */
export class MeshArcError extends Error {
  /** HTTP status of the response. */
  readonly status: number;
  /** The API's message, or its parsed error body. */
  readonly detail: unknown;
  /** Machine-readable reason: validation, unauthorized, plan_limit, not_found, rate_limited, ... */
  readonly code: string;
  /** The id the API logged the request under; quote it to support. */
  readonly requestId: string;

  constructor(status: number, detail: unknown, code = '', requestId = '') {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    super(`${status}: ${text}${requestId ? ` [${requestId}]` : ''}`);
    this.name = 'MeshArcError';
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * A job the client stopped waiting for while it was still running.
 *
 * It is also a MeshArcError, with status 0 and code 'timeout', so one
 * `catch (e) { if (e instanceof MeshArcError) ... }` covers it. An HTTP
 * request that timed out carries code 'timeout' too; tell the two apart with
 * `e instanceof MeshArcTimeoutError` or by `jobId`.
 */
export class MeshArcTimeoutError extends MeshArcError {
  /** The job that is still running; poll it later with the matching `get*` method. */
  readonly jobId: string;

  constructor(message: string, jobId = '') {
    super(0, message, 'timeout');
    this.message = message;
    this.name = 'MeshArcTimeoutError';
    this.jobId = jobId;
  }
}

export interface MeshArcOptions {
  /** Falls back to the MESHARC_API_KEY environment variable. */
  apiKey?: string;
  /** Milliseconds a single HTTP request may take before it is aborted. Default 150 000. */
  timeoutMs?: number;
  /** Retries on 429, 502, 503, 504 and network failures, for requests that are safe to repeat. Default 2. */
  maxRetries?: number;
  /** A fetch implementation to use instead of the global one. */
  fetch?: typeof fetch;
  /**
   * The API's base URL; falls back to MESHARC_API_URL, then the hosted API.
   * Must be https:// — the key travels as a bearer header — except for a
   * local API on localhost.
   */
  baseUrl?: string;
}

export type Json = Record<string, unknown>;
export type Config = Json;

export interface WaitOptions {
  /** `false` returns the job envelope at once instead of waiting for it to finish. */
  wait?: boolean;
  /** Milliseconds between polls. */
  pollMs?: number;
  /** Milliseconds to wait before throwing MeshArcTimeoutError. */
  timeoutMs?: number;
}

type Params = Record<string, string | number | undefined>;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

function isRunning(status: unknown): boolean {
  return status === 'queued' || status === 'running';
}

export class MeshArc {
  readonly projects: Projects;
  readonly runs: Runs;
  /** Web searches and agent requests kept and run on a schedule. Not `monitor()`, the job queue. */
  readonly monitors: Monitors;

  readonly #key: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  /**
   * `new MeshArc('mesharc_...')`, `new MeshArc({ apiKey, timeoutMs })`, or
   * `new MeshArc()` with MESHARC_API_KEY set in the environment.
   */
  constructor(apiKey?: string | MeshArcOptions, options: MeshArcOptions = {}) {
    if (apiKey && typeof apiKey === 'object') {
      options = apiKey;
      apiKey = options.apiKey;
    }
    const key = apiKey || options.apiKey || readEnv('MESHARC_API_KEY') || '';
    if (!key) throw new Error('An API key is required: new MeshArc("mesharc_...") or set MESHARC_API_KEY.');
    this.#key = key;
    this.base = baseUrlOf(options.baseUrl ?? readEnv('MESHARC_API_URL') ?? DEFAULT_BASE);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('No fetch available: use Node 18+ or pass { fetch }.');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.projects = new Projects(this);
    this.runs = new Runs(this);
    this.monitors = new Monitors(this);
  }

  /** What console.log and util.inspect show: the key is never printed. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `MeshArc { base: '${this.base}', key: '${redact(this.#key)}', timeoutMs: ${this.timeoutMs}, maxRetries: ${this.maxRetries} }`;
  }

  /** Any API route. Resolves to the parsed JSON body (undefined for 204 or an empty body). */
  async call<T = Json>(method: string, path: string, body?: unknown, params?: Params, idempotencyKey?: string): Promise<T> {
    const res = await this.request(method, path, body, params, idempotencyKey);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text.trim()) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** Any API route, resolving to the raw Response — for streamed bodies such as exports. */
  raw(method: string, path: string, body?: unknown, params?: Params, idempotencyKey?: string): Promise<Response> {
    return this.request(method, path, body, params, idempotencyKey);
  }

  // What the last response said about the key's rate limit, so a polling
  // loop can slow down before it is refused rather than after.
  private remaining: number | null = null;
  private resetAt = 0;

  private noteLimits(res: Response) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === null) return;
    const n = Number(remaining);
    if (!Number.isFinite(n)) return;
    this.remaining = n;
    this.resetAt = Date.now() + Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
  }

  /**
   * Waits out the window when the key is nearly out of requests. A wait loop
   * that polls every few seconds would otherwise spend a small plan's minute
   * on polling and be refused for the call that matters.
   */
  async pace(floor = 3): Promise<void> {
    if (this.remaining !== null && this.remaining <= floor) {
      const left = this.resetAt - Date.now();
      if (left > 0) await sleep(Math.min(left, 60_000));
      this.remaining = null;
    }
  }

  private async request(method: string, path: string, body?: unknown, params?: Params, idempotencyKey?: string): Promise<Response> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#key}`,
      'User-Agent': `mesharc-node/${VERSION}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    // A GET or DELETE is safe to repeat; a POST only when it carries an idempotency key.
    const repeatable = method === 'GET' || method === 'DELETE' || !!idempotencyKey;

    for (let attempt = 0; ; attempt++) {
      // Out of requests this minute: wait for the window rather than send a call that will only be refused.
      await this.pace(0);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body: payload, signal: controller.signal });
      } catch (err) {
        if (repeatable && attempt < this.maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        const aborted = (err as { name?: string }).name === 'AbortError';
        throw new MeshArcError(0, aborted ? `request timed out after ${this.timeoutMs} ms` : String((err as Error).message ?? err), aborted ? 'timeout' : 'network');
      } finally {
        clearTimeout(timer);
      }
      this.noteLimits(res);
      if (res.status < 400) return res;
      if (RETRY_STATUSES.has(res.status) && repeatable && attempt < this.maxRetries) {
        await sleep(retryAfterMs(res) ?? backoff(attempt));
        continue;
      }
      throw await errorFrom(res);
    }
  }

  /** One URL with every format, as the app's playground reads it. Resolves to the finished extraction. */
  async extract(url: string, config?: Config, opts: WaitOptions = {}): Promise<Json> {
    const job = await this.call<{ id: string }>('POST', '/playground/extract', config ? { url, config } : { url });
    if (opts.wait === false) return job;
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    for (;;) {
      const r = await this.call<{ status: string }>('GET', `/playground/${seg(job.id)}`);
      if (!isRunning(r.status)) return r;
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`extraction ${job.id} is still ${r.status}`, job.id);
      await sleep(opts.pollMs ?? 2000);
      await this.pace();
    }
  }

  /**
   * URLs in, their content out; no project.
   *
   * One URL (a string) resolves to the page itself: the API holds the request
   * open until the page comes back. An array is a batch and resolves to the
   * finished batch, one row per URL, unless `wait` is false.
   */
  async scrape(urls: string | string[], config?: Config, opts: ScrapeOptions & { webhookUrl?: string } = {}): Promise<Json> {
    if (typeof urls === 'string') return this.scrapeOne(urls, config, opts);
    const body: Json = { urls };
    if (config) body.config = config;
    if (opts.webhookUrl) body.webhook_url = opts.webhookUrl;
    const batch = await this.call<{ id: string }>('POST', '/scrape', body, undefined, opts.idempotencyKey);
    if (opts.wait === false) return batch;
    return this.batch(batch.id, { ...opts, wait: true });
  }

  /** One URL, waited for. Resolves to the page; `wait: false` resolves to the job envelope. */
  async scrapeOne(url: string, config?: Config, opts: ScrapeOptions = {}): Promise<Json> {
    const formats = opts.formats ?? 'markdown';
    const body: Json = { url, formats, timeout: opts.apiTimeoutS ?? 60 };
    if (config) body.config = config;
    let out = await this.call<ScrapeEnvelope>('POST', '/scrape', body, undefined, opts.idempotencyKey);
    if (opts.wait === false) return out;
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    for (;;) {
      if (out.status === 'done') return out.data?.[0] ?? {};
      if (!isRunning(out.status)) throw new MeshArcError(502, out.error ?? `scrape ${out.status}`, 'job_failed');
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`scrape ${out.id} is still ${out.status}`, out.id);
      await sleep(opts.pollMs ?? 2000);
      await this.pace();
      out = await this.call<ScrapeEnvelope>('GET', `/scrape/${seg(out.id)}`, undefined, { formats });
    }
  }

  /** A batch started earlier. With `wait`, resolves once every row is in. */
  async batch(batchId: string, opts: { formats?: string } & WaitOptions = {}): Promise<Json> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
    for (;;) {
      const r = await this.call<{ status: string }>('GET', `/scrape/${seg(batchId)}`, undefined, { formats: opts.formats ?? 'markdown' });
      if (!opts.wait || !isRunning(r.status)) return r;
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`batch ${batchId} is still ${r.status}`, batchId);
      await sleep(opts.pollMs ?? 3000);
      await this.pace();
    }
  }

  /**
   * Crawl a site once, with no project to set up first. Resolves to a Crawl
   * handle as soon as the job is queued; `wait: true` waits for it to finish.
   *
   * Options are the request's own names — limit, maxDepth, includePaths,
   * excludePaths, crawlMode, maxAge, maxTier, scrapeOptions, webhook — and
   * `config` takes any project setting directly.
   */
  async crawl(url: string, opts: CrawlOptions = {}): Promise<Crawl> {
    const { wait, pollMs, timeoutMs, idempotencyKey, ...body } = opts;
    const job = new Crawl(this, await this.call('POST', '/crawl', { url, ...body }, undefined, idempotencyKey));
    if (wait) await job.wait({ pollMs, timeoutMs });
    return job;
  }

  /** A handle on a crawl started earlier or elsewhere. */
  async getCrawl(crawlId: string): Promise<Crawl> {
    return new Crawl(this, await this.call('GET', `/crawl/${seg(crawlId)}`, undefined, { limit: 1 }));
  }

  /** Every URL a site declares in its sitemaps. `mapDetails` adds how they were found. */
  async map(url: string, opts: MapOptions = {}): Promise<Json[]> {
    return (await this.mapDetails(url, opts)).data as Json[];
  }

  /**
   * A map with everything the API said about it: how the sitemaps were
   * found, the totals, what robots.txt allowed, and the URLs under `data`.
   */
  async mapDetails(url: string, opts: MapOptions = {}): Promise<Json> {
    const { search, limit, apiTimeoutS, pollMs, timeoutMs, ...rest } = opts;
    const body: Json = { url, timeout: apiTimeoutS ?? 10, ...rest };
    if (search) body.search = search;
    if (limit) body.limit = limit;
    let out = await this.call<{ id: string; status: string; error?: string; data: Json[] }>('POST', '/map', body);
    const deadline = Date.now() + (timeoutMs ?? 300_000);
    while (out.status === 'running') {
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`map ${out.id} is still reading ${url}`, out.id);
      await sleep(pollMs ?? 2000);
      await this.pace();
      out = await this.call('GET', `/map/${seg(out.id)}`, undefined, { search, limit });
    }
    if (out.status !== 'done') throw new MeshArcError(502, out.error ?? 'no sitemap could be read', 'job_failed');
    return out;
  }

  /**
   * Web results for a query: title, URL and snippet per result, each naming
   * the engine it came from. Not to be confused with `search`, which looks
   * inside a project's pages. `news` reads the engines' news results instead,
   * each with its publisher and age; `page` reads further in (page 2 is
   * results 11 to 20).
   *
   * Needs a key that can write, and spends credits: a refused results page
   * is free, and an equal search within an hour (ten minutes for news) of a
   * finished one is answered from the cache with no charge for the results
   * page. With `scrape`, each result's page is fetched too and charged as a
   * scrape; valid formats are markdown, text, rawHtml, cleanHtml, links, raw,
   * screenshot and json.
   *
   * Resolves to the finished search. When every engine refuses, the search
   * resolves with status `blocked` rather than throwing. `wait: false`
   * resolves to the first answer, which may still be queued or running.
   */
  async webSearch(query: string, opts: WebSearchOptions = {}): Promise<WebSearchResult> {
    const body: Json = { query };
    if (opts.limit !== undefined) body.limit = opts.limit;
    if (opts.country !== undefined) body.country = opts.country;
    if (opts.lang !== undefined) body.lang = opts.lang;
    if (opts.news) body.sources = ['news'];
    if (opts.page !== undefined) body.page = opts.page;
    if (opts.freshness !== undefined) body.freshness = opts.freshness;
    if (opts.includeDomains !== undefined) body.includeDomains = opts.includeDomains;
    if (opts.excludeDomains !== undefined) body.excludeDomains = opts.excludeDomains;
    if (opts.destination !== undefined) body.destination = opts.destination;
    if (opts.scrape === true) body.scrape = { formats: ['markdown'] };
    else if (opts.scrape) body.scrape = opts.scrape;
    body.timeout = opts.apiTimeoutS ?? (opts.wait !== false ? 60 : 0);
    let out = await this.call<WebSearchResult>('POST', '/search', body, undefined, opts.idempotencyKey);
    if (opts.wait === false) return out;
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    for (;;) {
      if (out.status === 'done' || out.status === 'blocked') return out;
      if (!isRunning(out.status)) throw new MeshArcError(502, out.error || `search ${out.status}`, 'job_failed');
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`search ${out.id} is still ${out.status}`, out.id);
      await sleep(opts.pollMs ?? 2000);
      await this.pace();
      out = await this.call<WebSearchResult>('GET', `/search/${seg(out.id)}`);
    }
  }

  /** A web search started earlier, as it stands now. */
  getSearch(searchId: string): Promise<WebSearchResult> {
    return this.call<WebSearchResult>('GET', `/search/${seg(searchId)}`);
  }

  /** The workspace's web searches, newest first; `q` keeps those whose query contains it. */
  async *searches(opts: { q?: string; limit?: number } = {}): AsyncGenerator<SearchSummary> {
    yield* paged<SearchSummary>(this, '/search', { q: opts.q, limit: opts.limit ?? 25 });
  }

  /**
   * Ask the agent: it searches, reads pages and answers the prompt, as JSON
   * matching `schema` when one is given and as `{ text }` otherwise.
   *
   * Needs a key that can write, and spends credits: each page as it is read
   * (a refused page is free) and the model's tokens at the model provider's
   * price plus 20%, or 1 credit per 1,000 tokens on the workspace's own
   * connection (`connectionId`). `maxCredits` caps what one run may spend; a
   * run that reaches it stops with status `credit_limit` and what it had
   * under `data.partial`, and `run.continue()` carries it on.
   *
   * Resolves to an AgentRun at once, or once the run finishes or
   * `apiTimeoutS` passes (120 at most), whichever comes first; `run.wait()`
   * waits for the answer and `run.trace()` follows the steps. With a
   * `webhook`, its signing secret is `run.webhookSecret`, once.
   */
  async agent(prompt: string, opts: AgentOptions = {}): Promise<AgentRun> {
    const body: Json = { prompt };
    if (opts.urls !== undefined) body.urls = opts.urls;
    if (opts.schema !== undefined) body.schema = opts.schema;
    if (opts.maxCredits !== undefined) body.maxCredits = opts.maxCredits;
    if (opts.maxSteps !== undefined) body.maxSteps = opts.maxSteps;
    if (opts.allowedDomains !== undefined) body.allowedDomains = opts.allowedDomains;
    if (opts.webhook !== undefined) body.webhook = opts.webhook;
    if (opts.connectionId !== undefined) body.connectionId = opts.connectionId;
    if (opts.apiTimeoutS !== undefined && opts.apiTimeoutS > 0) body.timeout = Math.min(opts.apiTimeoutS, 120);
    return new AgentRun(this, await this.call<AgentEnvelope>('POST', '/agent', body, undefined, opts.idempotencyKey));
  }

  /**
   * A handle on an agent run started earlier or elsewhere. A run past its
   * keep date (7 days by default) throws MeshArcError with status 410 and
   * code 'expired'.
   */
  async getAgent(runId: string): Promise<AgentRun> {
    return new AgentRun(this, await this.call<AgentEnvelope>('GET', `/agent/${seg(runId)}`));
  }

  /**
   * The workspace's agent runs, newest first. `status` keeps those in that
   * state, `model` one model's runs, and `since` / `until` those made from /
   * before a date or date-time. An invalid Date throws a TypeError on the
   * first iteration, before any request is made.
   */
  async *agentRuns(opts: AgentRunsOptions = {}): AsyncGenerator<AgentSummary> {
    const filters = { status: opts.status, model: opts.model, since: isoOf('since', opts.since), until: isoOf('until', opts.until) };
    yield* paged<AgentSummary>(this, '/agent', { ...filters, limit: opts.limit ?? 25 });
  }

  /** The pages of a run (the latest finished run by default). */
  pages(projectId: string, runId?: string): Promise<Json> {
    return this.call('GET', `/projects/${seg(projectId)}/pages`, undefined, { run_id: runId });
  }

  /** One page in full: bodies, head fields, structured fields, versions. */
  page(projectId: string, url: string, runId?: string): Promise<Json> {
    return this.call('GET', `/projects/${seg(projectId)}/pages/content`, undefined, { url, run_id: runId });
  }

  /** The change record of a run against the run before it. */
  changes(projectId: string, runId?: string): Promise<Json> {
    return this.call('GET', `/projects/${seg(projectId)}/changes`, undefined, { run_id: runId });
  }

  /** The word-level diff of one page against the run before. */
  pageDiff(projectId: string, url: string, runId?: string): Promise<Json> {
    return this.call('GET', `/projects/${seg(projectId)}/changes/page`, undefined, { url, run_id: runId });
  }

  /** Which pages say this (`content`: words, "phrases") or contain this (`selector`: CSS or XPath). */
  search(projectId: string, q: string, mode: 'content' | 'selector' = 'content', runId?: string): Promise<Json> {
    return this.call('POST', `/projects/${seg(projectId)}/pages/search`, { mode, q, run_id: runId });
  }

  /** Fetch these pages again now, as a scoped run. */
  recrawl(projectId: string, urls: string[]): Promise<Json> {
    return this.call('POST', `/projects/${seg(projectId)}/pages/recrawl`, { urls });
  }

  /** The seed, sitemap, URL list, feeds and patterns, with what the last run found through each. */
  sources(projectId: string): Promise<Json> {
    return this.call('GET', `/projects/${seg(projectId)}/sources`);
  }

  /** A dataset as a stream. Resolves to the Response; read `.body`, `.text()` or pipe it. */
  export(projectId: string, opts: ExportOptions = {}): Promise<Response> {
    const dataset = opts.dataset ?? 'pages';
    const format = opts.format ?? 'jsonl';
    if (opts.urls) {
      return this.raw('POST', `/projects/${seg(projectId)}/export`, { dataset, format, run_id: opts.runId, urls: opts.urls });
    }
    return this.raw('GET', `/projects/${seg(projectId)}/export`, undefined, { dataset, format, run_id: opts.runId });
  }

  /** The workspace, its plan and limits, and what this key may do. */
  me(): Promise<Json> {
    return this.call('GET', '/me');
  }

  keys(): Promise<Json[]> {
    return this.call<Json[]>('GET', '/me/keys');
  }

  /** A new API key. The plaintext is in the response under `key`, once. */
  createKey(name = 'default', opts: KeyOptions = {}): Promise<Json> {
    const body: Json = { name };
    if (opts.scopes) body.scopes = opts.scopes;
    if (opts.projects !== undefined) body.projects = opts.projects;
    if (opts.expiresInDays) body.expires_in_days = opts.expiresInDays;
    if (opts.rpm) body.rpm = opts.rpm;
    return this.call('POST', '/me/keys', body);
  }

  revokeKey(keyId: string): Promise<void> {
    return this.call<void>('DELETE', `/me/keys/${seg(keyId)}`);
  }

  usage(): Promise<Json> {
    return this.call('GET', '/me/usage');
  }

  /**
   * The workspace's job queue: what is queued and running now (GET /me/monitor).
   * Not `arc.monitors`, the searches and agent requests kept on a schedule.
   */
  monitor(): Promise<Json> {
    return this.call('GET', '/me/monitor');
  }

  /** Verdict meanings, engine costs, the configuration defaults and the ladder. */
  meta(): Promise<Json> {
    return this.call('GET', '/meta');
  }
}

export interface ScrapeOptions extends WaitOptions {
  /** Comma-separated bodies to return: markdown, text, cleanHtml, rawHtml. Default markdown. */
  formats?: string;
  /** Seconds the API holds the request open for the page (60 by default, 120 at most). */
  apiTimeoutS?: number;
  /** The same key within 24 hours returns the first answer rather than starting a second job. */
  idempotencyKey?: string;
}

export interface CrawlOptions extends WaitOptions {
  limit?: number;
  maxDepth?: number;
  includePaths?: string[];
  excludePaths?: string[];
  crawlMode?: 'sitemap_first' | 'sitemap_only' | 'links';
  sitemapMode?: 'auto' | 'listed' | 'off';
  allowSubdomains?: boolean;
  respectRobots?: boolean;
  maxAge?: number;
  maxTier?: 'http' | 'browser' | 'stealth';
  delay?: number;
  concurrency?: number;
  scrapeOptions?: Json;
  webhook?: string | { url: string; events?: string[]; metadata?: Json };
  config?: Config;
  idempotencyKey?: string;
  [option: string]: unknown;
}

export interface MapOptions extends WaitOptions {
  search?: string;
  limit?: number;
  /** Seconds the API waits for the sitemap tree before answering with a job (10 by default, 60 at most). */
  apiTimeoutS?: number;
  [option: string]: unknown;
}

export interface WebSearchOptions extends WaitOptions {
  /** How many results to return, 1 to 10. */
  limit?: number;
  /** Two-letter country code the results are for. */
  country?: string;
  /** Language of the results. */
  lang?: string;
  /** Read the engines' news results instead of the web ones; each carries its publisher and age. */
  news?: boolean;
  /** Which results page, 1 to 10: page 2 is results 11 to 20. Each page is its own search. */
  page?: number;
  /** Only results published within this period. */
  freshness?: 'hour' | 'day' | 'week' | 'month' | 'year';
  /** Keep only results from these domains (20 at most). */
  includeDomains?: string[];
  /** Drop results from these domains (20 at most). */
  excludeDomains?: string[];
  /** Fetch each result's page too: `true` for markdown, or the formats and a credit cap. */
  scrape?: boolean | { formats?: string[]; maxCredits?: number };
  /** A destination to deliver the results to. */
  destination?: string;
  /** Seconds the API holds the request open for the results (60 by default, 0 with `wait: false`, 120 at most). */
  apiTimeoutS?: number;
  /** The same key within 24 hours returns the first answer rather than starting a second search. */
  idempotencyKey?: string;
}

/** One web search result. */
export interface WebSearchHit extends Json {
  position: number;
  url: string;
  title: string;
  snippet: string;
  /** The kind of result: `web` for an organic result, `news` for a news one. */
  source: string;
  engine: string;
  /** A news result: who published it. */
  publisher?: string | null;
  /** A news result: how old it is, as the engine put it ("20h"). */
  age?: string | null;
  /**
   * The result's page when the search scraped it; `{ url, status: 'pending' | 'expired' }` until it
   * lands or after it is gone; null or absent when the search did not scrape.
   */
  page?: Json | null;
}

/** One engine's try at the results page. */
export interface SearchAttempt extends Json {
  engine?: string | null;
  ok?: boolean | null;
  reason?: string | null;
  rung?: string | null;
  verdict?: string | null;
  credits?: number | null;
}

/** A web search: its status, the results under `data`, and what it cost. */
export interface WebSearchResult extends Json {
  id: string;
  kind: 'search';
  /** queued, running (also while scraped pages land), done, blocked (every engine refused; free) or error. */
  status: string;
  query: string;
  params: Json;
  data: WebSearchHit[];
  engine: string;
  rung: string;
  cached: boolean;
  batchId: string | null;
  creditsUsed: number;
  attempts: SearchAttempt[];
  /** The URL to poll while the search runs; null once it is finished. */
  next: string | null;
  /** Empty when there is no error. */
  error: string;
  createdAt: string | null;
  finishedAt: string | null;
  request_id: string;
}

/** One line of the web search history. */
export interface SearchSummary extends Json {
  id: string;
  query: string;
  params: Json;
  status: string;
  engine: string;
  rung: string;
  cached: boolean;
  resultCount: number;
  /** The first three results' hosts. */
  domains: string[];
  scraped: boolean;
  creditsUsed: number;
  error: string;
  createdAt: string | null;
  finishedAt: string | null;
}

export interface AgentOptions {
  /** Pages to start from (20 at most). */
  urls?: string[];
  /** A JSON Schema whose type is "object" or "array"; the answer under `data` matches it. */
  schema?: Json;
  /** The most credits the run may spend, 1 to 100 000 (2000 by default). */
  maxCredits?: number;
  /** The most steps the run may take, 1 to 100 (40 by default). */
  maxSteps?: number;
  /** Read only pages on these domains (20 at most). */
  allowedDomains?: string[];
  /**
   * Be told of the run's life: a URL, or `{ url, events, metadata }` with events from
   * agent.started, agent.action, agent.completed, agent.failed and agent.cancelled (all
   * five by default). The secret its messages are signed with is `run.webhookSecret`, once.
   */
  webhook?: WebhookSpec;
  /**
   * One of the workspace's LLM connections: the run uses that model, on the workspace's
   * own key, and its tokens cost 1 credit per 1,000.
   */
  connectionId?: string;
  /** Seconds the API holds the request open for the answer (none by default, 120 at most). */
  apiTimeoutS?: number;
  /** The same key within 24 hours returns the first answer rather than starting a second run. */
  idempotencyKey?: string;
}

/** Where to send a job's webhook messages: a URL, or the URL with the events wanted and metadata echoed back. */
export type WebhookSpec = string | { url: string; events?: string[]; metadata?: Json };

/** What `AgentRun.continue` gives the new run; the stopped run's own values when left out. */
export interface AgentContinueOptions {
  /** The new run's budget, 1 to 100 000. */
  maxCredits?: number;
  /** The new run's step limit, 1 to 100. */
  maxSteps?: number;
  /** Seconds the API holds the request open for the answer (none by default, 120 at most). */
  apiTimeoutS?: number;
  /** The same key within 24 hours returns the first answer rather than starting a second run. */
  idempotencyKey?: string;
}

/** Where an agent run stands; `expired` once its answer is past its keep date. */
export type AgentStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'credit_limit' | 'expired';

/** What `agentRuns` keeps. */
export interface AgentRunsOptions {
  /** Only the runs in this status. */
  status?: AgentStatus;
  /** One model's runs, by the name runs show it under, e.g. `openai:gpt-5.4-mini`. */
  model?: string;
  /**
   * Runs made from this date or date-time on (ISO 8601; a Date is sent as its ISO string,
   * and an invalid Date throws a TypeError before any request).
   */
  since?: string | Date;
  /** Runs made before this date or date-time (ISO 8601; a Date as for `since`). */
  until?: string | Date;
  /** Runs per page. */
  limit?: number;
}

/** A page the agent's answer drew on. */
export interface AgentSource extends Json {
  url: string;
  title: string;
  /** The stored page it was read from; '' when there is none. */
  pageId: string;
}

/** The page one value of a schema answer came from. */
export interface AgentFieldSource extends Json {
  url: string;
  pageId: string;
}

/** An agent run: its status while it works, its answer and sources after. */
export interface AgentEnvelope extends Json {
  id: string;
  kind: 'agent';
  /** queued, running, done, error, cancelled, credit_limit, or expired once its answer is gone. */
  status: string;
  prompt: string;
  params: Json;
  /** The answer: JSON matching the schema, `{ text }` without one, `{ partial }` at credit_limit. */
  data: unknown;
  /**
   * Where each value of a schema answer came from: its path in `data` ("plans[0].price",
   * or "[2].name" for a list answer) to the page that said it.
   */
  fieldSources?: Record<string, AgentFieldSource>;
  sources: AgentSource[];
  creditsUsed: number;
  /** The most this run may spend: maxCredits, or less when the workspace had less left (budgetLimited). */
  budget: number;
  budgetLimited: boolean;
  tokens: { in: number; out: number };
  steps: number;
  model: string;
  /** Runs carried on from one another share a thread. */
  threadId: string;
  /** The run this one carried on (`AgentRun.continue`); null for a first run. */
  continuesRunId?: string | null;
  /** The run that carried this one on, whose answer replaces this one's partial; null until one does. */
  continuedBy?: string | null;
  stopReason: string;
  /** Empty when there is no error. */
  error: string;
  /** The URL to poll while the run works; null once it is finished. */
  next: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  request_id: string;
  /** Only on the answer to the POST that set a webhook: the secret its messages are signed with. */
  webhookSecret?: string | null;
}

/** One step of an agent run's trace. */
export interface AgentEvent extends Json {
  seq: number;
  t: string | null;
  /** start, resume, continue, model, search, fetch, render, map, select, extract, tool, busy or finish. */
  kind: string;
  text: string;
  [field: string]: unknown;
}

/** One page of an agent run's trace; `last` is the seq to pass as `after` next. */
export interface AgentTrace extends Json {
  data: AgentEvent[];
  last: number;
}

/** One line of the agent run history. */
export interface AgentSummary extends Json {
  id: string;
  prompt: string;
  status: string;
  model: string;
  steps: number;
  /** Runs carried on from one another share a thread. */
  threadId: string;
  continuesRunId?: string | null;
  continuedBy?: string | null;
  creditsUsed: number;
  error: string;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What a monitor re-runs: a web search or an agent request. */
export type MonitorKind = 'search' | 'agent';

/** How often a monitor runs. */
export type MonitorSchedule = 'hourly' | 'daily' | 'weekly';

/**
 * What a search monitor runs: the body of a POST /search, by the API's own names. A news
 * monitor is `sources: ['news']`. There is no `scrape`: a monitored search reads its results
 * page only.
 */
export interface SearchMonitorRequest {
  query: string;
  /** How many results to read, 1 to 10. */
  limit?: number;
  /** `['web']` (the default) or `['news']`. */
  sources?: ('web' | 'news')[];
  /** Which results page, 1 to 10: page 2 is results 11 to 20. */
  page?: number;
  /** Two-letter country code the results are for. */
  country?: string;
  /** Language of the results. */
  lang?: string;
  /** Only results published within this period. */
  freshness?: 'hour' | 'day' | 'week' | 'month' | 'year';
  /** Keep only results from these domains (20 at most). */
  includeDomains?: string[];
  /** Drop results from these domains (20 at most). */
  excludeDomains?: string[];
}

/** What an agent monitor runs: the body of a POST /agent, by the API's own names. */
export interface AgentMonitorRequest {
  prompt: string;
  /** Pages to start from (20 at most). */
  urls?: string[];
  /** A JSON Schema whose type is "object" or "array"; each run's answer matches it. */
  schema?: Json;
  /** The most credits one run may spend, 1 to 100 000 (2000 by default). */
  maxCredits?: number;
  /** The most steps one run may take, 1 to 100 (40 by default). */
  maxSteps?: number;
  /** Read only pages on these domains (20 at most). */
  allowedDomains?: string[];
  /** One of the workspace's LLM connections, to run on its model and key. */
  connectionId?: string;
}

export interface CreateMonitorOptions {
  /** The query or prompt when left out; at most 120 characters. */
  name?: string;
  /**
   * Be told when a run's results changed: a URL, or `{ url, events, metadata }` with
   * `search.changed` for a search monitor, `agent.changed` for an agent one. The secret
   * its messages are signed with is in the answer once, as `webhookSecret`.
   */
  webhook?: WebhookSpec;
  /**
   * A finished search or agent run with the same request: the first run, not paid for again.
   * A search baseline's `limit` must be at least the monitor's.
   */
  baselineId?: string;
  /** The same key within 24 hours returns the first answer rather than making a second monitor. */
  idempotencyKey?: string;
}

/** What `monitors.update` changes; what is left out stays as it is. */
export interface MonitorUpdate {
  /** At most 120 characters. */
  name?: string;
  schedule?: MonitorSchedule;
  /** `paused` stops the scheduled runs; `active` starts them again. */
  status?: 'active' | 'paused';
  /** A new webhook (with a new secret, in the answer once), or '' for none. */
  webhook?: WebhookSpec | '';
}

/** One run of a monitor: the search or agent run it made, and what changed since the last one that answered. */
export interface MonitorRun extends Json {
  id: string;
  monitorId: string;
  kind: MonitorKind;
  /** first, baseline, scheduled or manual. */
  trigger: string;
  /** running; then the search's or agent run's own status (done, blocked, error, credit_limit, cancelled), or skipped (no credits left). */
  status: string;
  /** The search or agent run this run made: `getSearch(refId)` or `getAgent(refId)`. */
  refId: string;
  credits: number;
  /** False when it did not answer: it is kept, and nothing is compared with it. */
  answered: boolean;
  changed: boolean;
  /** One line on what changed. */
  summary: string;
  /**
   * The comparison: for a search `{ baseline, withheld, comparable, new, dropped, moved, changed, summary }`,
   * for an agent run `{ baseline, withheld, changed, counts, changes, summary }`; null until the run has
   * finished. `withheld` is a reason string, '' when the run answered and was compared.
   */
  diff: Json | null;
  /** Empty when there is no error. */
  error: string;
  createdAt: string | null;
  finishedAt: string | null;
}

/** A search or agent request kept and run on a schedule. */
export interface Monitor extends Json {
  id: string;
  kind: MonitorKind;
  name: string;
  /** The POST /search or POST /agent body it runs, as the API cleaned it. */
  request: Json;
  schedule: MonitorSchedule;
  status: 'active' | 'paused';
  /** Where `search.changed` / `agent.changed` go; never the secret. */
  webhook: { url: string; events: string[] } | null;
  /** Null while it is paused. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRun: MonitorRun | null;
  createdAt: string | null;
  /** Only on the answer that set the webhook: the secret its messages are signed with. */
  webhookSecret?: string | null;
}

/**
 * What `export` streams. The API refuses some dataset/format pairs:
 * 'llms' and 'llms-full' come only as 'txt', 'txt' only for those two, and
 * 'markdown' only as 'jsonl'.
 */
export interface ExportOptions {
  dataset?: 'pages' | 'markdown' | 'changes' | 'fields' | 'sitemap' | 'rows' | 'row-events' | 'llms' | 'llms-full';
  format?: 'jsonl' | 'csv' | 'txt';
  runId?: string;
  urls?: string[];
}

export interface KeyOptions {
  scopes?: string[];
  projects?: string[] | null;
  expiresInDays?: number;
  rpm?: number;
}

interface ScrapeEnvelope extends Json {
  id: string;
  status: string;
  data?: Json[];
  error?: string;
}

export class Projects {
  constructor(private readonly client: MeshArc) {}

  list(): Promise<Json[]> {
    return this.client.call<Json[]>('GET', '/projects');
  }

  create(seed: string, opts: { name?: string; schedule?: string; retention?: string; config?: Config } = {}): Promise<Json> {
    const body: Json = { seed, schedule: opts.schedule ?? 'manual', retention: opts.retention ?? '90d' };
    if (opts.name) body.name = opts.name;
    if (opts.config) body.config = opts.config;
    return this.client.call('POST', '/projects', body);
  }

  get(projectId: string): Promise<Json> {
    return this.client.call('GET', `/projects/${seg(projectId)}`);
  }

  update(projectId: string, fields: Json): Promise<Json> {
    return this.client.call('PATCH', `/projects/${seg(projectId)}`, fields);
  }

  delete(projectId: string): Promise<void> {
    return this.client.call<void>('DELETE', `/projects/${seg(projectId)}`);
  }
}

export class Runs {
  constructor(private readonly client: MeshArc) {}

  list(projectId: string, limit = 25): Promise<Json[]> {
    return this.client.call<Json[]>('GET', `/projects/${seg(projectId)}/runs`, undefined, { limit });
  }

  get(projectId: string, runId: string): Promise<Json> {
    return this.client.call('GET', `/projects/${seg(projectId)}/runs/${seg(runId)}`);
  }

  async start(projectId: string, opts: WaitOptions = {}): Promise<Json> {
    const run = await this.client.call<{ id: string }>('POST', `/projects/${seg(projectId)}/runs`, { trigger: 'api' });
    return opts.wait ? this.wait(projectId, run.id, opts) : run;
  }

  async wait(projectId: string, runId: string, opts: WaitOptions = {}): Promise<Json> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
    for (;;) {
      const run = await this.get(projectId, runId);
      if (run.status !== 'running' && !run.queued) return run;
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`run ${runId} is still ${String(run.status)}`, runId);
      await sleep(opts.pollMs ?? 3000);
      await this.client.pace();
    }
  }

  cancel(projectId: string, runId: string): Promise<Json> {
    return this.client.call('POST', `/projects/${seg(projectId)}/runs/${seg(runId)}/cancel`);
  }
}

/**
 * Web searches and agent requests kept and run on a schedule: `arc.monitors`.
 * Each run is compared with the last one that answered, and a webhook hears
 * when something changed. Not `arc.monitor()`, the job queue.
 */
export class Monitors {
  constructor(private readonly client: MeshArc) {}

  /**
   * Keep a web search or an agent request and run it hourly, daily or weekly.
   * `request` is the body of a POST /search or POST /agent by the API's own
   * names: a news monitor is `{ query, sources: ['news'] }`, and a monitored
   * search reads its results page only, so it takes no `scrape`.
   *
   * Needs a key that can write. Each run is an ordinary search or agent run
   * and is charged as one. The first run is `baselineId` (a finished search
   * or agent run with the same request, not paid for again; a search
   * baseline's `limit` must be at least the monitor's) or starts now. A
   * `webhook` hears `search.changed` / `agent.changed` when a run found
   * something different; its signing secret is in the answer once, as
   * `webhookSecret`.
   */
  create(kind: 'search', request: SearchMonitorRequest, schedule: MonitorSchedule, opts?: CreateMonitorOptions): Promise<Monitor>;
  create(kind: 'agent', request: AgentMonitorRequest, schedule: MonitorSchedule, opts?: CreateMonitorOptions): Promise<Monitor>;
  create(kind: MonitorKind, request: SearchMonitorRequest | AgentMonitorRequest, schedule: MonitorSchedule,
    opts: CreateMonitorOptions = {}): Promise<Monitor> {
    const body: Json = { kind, request, schedule };
    if (opts.name !== undefined) body.name = opts.name;
    if (opts.webhook !== undefined) body.webhook = opts.webhook;
    if (opts.baselineId !== undefined) body.baselineId = opts.baselineId;
    return this.client.call<Monitor>('POST', '/monitors', body, undefined, opts.idempotencyKey);
  }

  /** The workspace's monitors, newest first, each with its last run; `kind` keeps the search or the agent ones. */
  async list(opts: { kind?: MonitorKind } = {}): Promise<Monitor[]> {
    return (await this.client.call<{ data: Monitor[] }>('GET', '/monitors', undefined, { kind: opts.kind })).data;
  }

  /** One monitor, with its last run. */
  get(monitorId: string): Promise<Monitor> {
    return this.client.call<Monitor>('GET', `/monitors/${seg(monitorId)}`);
  }

  /**
   * Change a monitor's name, schedule, status or webhook. A new webhook's
   * signing secret is in the answer once, as `webhookSecret`; `webhook: ''`
   * removes it.
   */
  update(monitorId: string, fields: MonitorUpdate): Promise<Monitor> {
    return this.client.call<Monitor>('PATCH', `/monitors/${seg(monitorId)}`, fields);
  }

  /** No more scheduled runs until it is resumed; a run under way finishes. */
  pause(monitorId: string): Promise<Monitor> {
    return this.client.call<Monitor>('POST', `/monitors/${seg(monitorId)}/pause`);
  }

  /** Scheduled again, from its last run: a slot that passed while it was paused runs once. */
  resume(monitorId: string): Promise<Monitor> {
    return this.client.call<Monitor>('POST', `/monitors/${seg(monitorId)}/resume`);
  }

  /**
   * Run a monitor now, paused or not; the schedule counts on from this run.
   * Resolves to the run as it starts. While one is under way the API refuses
   * with MeshArcError 409 'conflict'; when the workspace's credits are spent,
   * 402 'credits_exhausted'.
   */
  run(monitorId: string, opts: { idempotencyKey?: string } = {}): Promise<MonitorRun> {
    return this.client.call<MonitorRun>('POST', `/monitors/${seg(monitorId)}/run`, undefined, undefined, opts.idempotencyKey);
  }

  /** A monitor's runs, newest first, each with what changed since the run before that answered. */
  async *runs(monitorId: string, opts: { limit?: number } = {}): AsyncGenerator<MonitorRun> {
    yield* paged<MonitorRun>(this.client, `/monitors/${seg(monitorId)}/runs`, { limit: opts.limit ?? 25 });
  }

  /**
   * Delete a monitor and its runs. The searches and agent runs it made stay
   * in the workspace's history; an agent run it has under way is stopped.
   */
  delete(monitorId: string): Promise<{ id: string; deleted: boolean }> {
    return this.client.call<{ id: string; deleted: boolean }>('DELETE', `/monitors/${seg(monitorId)}`);
  }
}

/**
 * A crawl started by `arc.crawl(url)`: a handle on a running job.
 *
 * `wait()` blocks until it finishes; `pages()` yields pages as they land,
 * following the cursor, and ends when the job does; `keep()` turns the
 * one-shot crawl into a project; `cancel()` stops it.
 */
export class Crawl {
  readonly id: string;
  readonly url: string;
  readonly projectId: string;
  /** Returned once, at creation: the secret the crawl's webhook messages are signed with. */
  readonly webhookSecret: string;
  envelope: Json;

  constructor(private readonly client: MeshArc, envelope: Json) {
    this.id = envelope.id as string;
    this.url = (envelope.url as string) ?? '';
    this.projectId = (envelope.projectId as string) ?? '';
    this.webhookSecret = (envelope.webhookSecret as string) ?? '';
    this.envelope = envelope;
  }

  get status(): string {
    return (this.envelope.status as string) ?? 'queued';
  }

  /** The envelope as it stands now, without its pages. */
  async refresh(formats = 'markdown'): Promise<Json> {
    this.envelope = await this.client.call('GET', `/crawl/${seg(this.id)}`, undefined, { limit: 1, formats });
    return this.envelope;
  }

  async wait(opts: WaitOptions & { formats?: string } = {}): Promise<Json> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
    for (;;) {
      const e = await this.refresh(opts.formats);
      if (!isRunning(e.status)) return e;
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`crawl ${this.id} is still ${String(e.status)}`, this.id);
      await sleep(opts.pollMs ?? 3000);
      await this.client.pace();
    }
  }

  /**
   * Every page of the crawl, oldest first. While the crawl runs this waits
   * for more pages rather than stopping; `wait: false` returns what exists.
   */
  async *pages(opts: { formats?: string; limit?: number } & WaitOptions = {}): AsyncGenerator<Json> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
    let cursor: string | undefined;
    for (;;) {
      const page = await this.client.call<{ data: Json[]; next?: string; cursor?: string; status: string }>(
        'GET', `/crawl/${seg(this.id)}`, undefined, { formats: opts.formats ?? 'markdown', limit: opts.limit ?? 25, cursor },
      );
      const { data, ...envelope } = page;
      this.envelope = envelope;
      for (const row of data) yield row;
      // The cursor marks where this page ended, so a running crawl is never re-read from the top.
      cursor = page.cursor ?? cursor;
      if (page.next) {
        cursor = cursorOf(page.next) ?? cursor;
        continue;
      }
      if (opts.wait === false || !isRunning(page.status)) return;
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`crawl ${this.id} is still ${page.status}`, this.id);
      await sleep(opts.pollMs ?? 3000);
      await this.client.pace();
    }
  }

  /** Make this one-shot crawl a project. Its run and pages are already in place. */
  keep(opts: { name?: string; schedule?: string; retention?: string } = {}): Promise<Json> {
    return this.client.call('POST', `/crawl/${seg(this.id)}/keep`, opts);
  }

  async cancel(): Promise<Json> {
    await this.client.call<void>('DELETE', `/crawl/${seg(this.id)}`);
    this.envelope = { ...this.envelope, status: 'cancelled' };
    return this.envelope;
  }
}

/**
 * An agent run started by `arc.agent(prompt)`: a handle on the run.
 *
 * `wait()` blocks until it finishes; `trace()` yields its steps as they
 * happen; `cancel()` asks it to stop; `continue()` carries on a run that
 * stopped at its credit limit.
 */
export class AgentRun {
  readonly id: string;
  /**
   * Returned once, at creation: the secret the run's webhook messages are signed with. A
   * continuation keeps the webhook and this secret, so `continue()`'s handle carries it on.
   */
  readonly webhookSecret: string;
  /** The run as the API last described it. */
  envelope: AgentEnvelope;

  /** `webhookSecret` is the secret to keep when the envelope carries none (a continuation's). */
  constructor(private readonly client: MeshArc, envelope: AgentEnvelope, webhookSecret = '') {
    this.id = envelope.id;
    this.webhookSecret = envelope.webhookSecret || webhookSecret;
    this.envelope = envelope;
  }

  get status(): string {
    return this.envelope.status ?? 'queued';
  }

  /** The answer: JSON matching the schema, `{ text }` without one, `{ partial }` at credit_limit. */
  get data(): unknown {
    return this.envelope.data;
  }

  get sources(): AgentSource[] {
    return this.envelope.sources ?? [];
  }

  /** Where each value of a schema answer came from, by its path in `data` ("plans[0].price"). */
  get fieldSources(): Record<string, AgentFieldSource> {
    return this.envelope.fieldSources ?? {};
  }

  /** The run this one carried on; null for a first run. */
  get continuesRunId(): string | null {
    return this.envelope.continuesRunId ?? null;
  }

  /** The run that carried this one on; null until one does. */
  get continuedBy(): string | null {
    return this.envelope.continuedBy ?? null;
  }

  /** The run as it stands now. */
  async refresh(): Promise<this> {
    this.envelope = await this.client.call<AgentEnvelope>('GET', `/agent/${seg(this.id)}`);
    return this;
  }

  /**
   * Resolves to the envelope once the run is done, cancelled or stopped at
   * its credit limit; a run that failed throws MeshArcError 502 'job_failed'.
   */
  async wait(opts: WaitOptions = {}): Promise<AgentEnvelope> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
    for (;;) {
      const e = this.envelope;
      if (e.status === 'done' || e.status === 'credit_limit' || e.status === 'cancelled') return e;
      if (!isRunning(e.status)) throw new MeshArcError(502, e.error || `agent ${e.status}`, 'job_failed');
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`agent ${this.id} is still ${e.status}`, this.id);
      await sleep(opts.pollMs ?? 2000);
      await this.client.pace();
      await this.refresh();
    }
  }

  /**
   * Ask the run to stop. Resolves to the API's answer: 'cancelled' for a
   * queued run, 'cancelling' for a running one (it stops before its next
   * step), or a finished run's final status. `envelope` is left as it was;
   * `refresh()` reads the outcome.
   */
  cancel(): Promise<{ id: string; status: string }> {
    return this.client.call<{ id: string; status: string }>('DELETE', `/agent/${seg(this.id)}`);
  }

  /**
   * Carry on a run that stopped at its credit limit, with a new budget.
   * Resolves to a handle on the new run: on the same thread, it resumes from
   * where this one was, keeps the pages it read (not paid for again) and
   * answers in full. `maxCredits` and `maxSteps` are this run's when left
   * out. `envelope` is left as it was; `refresh()` reads `continuedBy`. The
   * new run posts to this run's webhook, signed with the same secret, so the
   * new handle keeps this one's `webhookSecret`.
   *
   * A run that did not stop at its limit, was already continued or has no
   * saved progress throws MeshArcError 409 'conflict'; one past its keep
   * date, 410 'expired'; one whose LLM connection can no longer be used, 400.
   */
  async continue(opts: AgentContinueOptions = {}): Promise<AgentRun> {
    const body: Json = {};
    if (opts.maxCredits !== undefined) body.maxCredits = opts.maxCredits;
    if (opts.maxSteps !== undefined) body.maxSteps = opts.maxSteps;
    if (opts.apiTimeoutS !== undefined && opts.apiTimeoutS > 0) body.timeout = Math.min(opts.apiTimeoutS, 120);
    const next = await this.client.call<AgentEnvelope>('POST', `/agent/${seg(this.id)}/continue`, body, undefined, opts.idempotencyKey);
    return new AgentRun(this.client, next, this.webhookSecret);
  }

  /**
   * The run's steps, oldest first, from after the seq `after`. While the run
   * works this waits for more steps rather than stopping; `follow: false`
   * returns what exists. Ends quietly once the run's trace has expired.
   */
  async *trace(opts: { after?: number; follow?: boolean; pollMs?: number; timeoutMs?: number } = {}): AsyncGenerator<AgentEvent> {
    const follow = opts.follow ?? true;
    const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
    let after = opts.after ?? 0;
    for (;;) {
      // The status is read before the trace, so the steps a run wrote as it finished are still drained.
      let live = false;
      if (follow) {
        try {
          live = isRunning((await this.refresh()).status);
        } catch (err) {
          if (isGone(err)) return;
          throw err;
        }
      }
      for (;;) {
        let page: AgentTrace;
        try {
          page = await this.client.call<AgentTrace>('GET', `/agent/${seg(this.id)}/trace`, undefined, { after, limit: 500 });
        } catch (err) {
          if (isGone(err)) return;
          throw err;
        }
        for (const event of page.data) yield event;
        const moved = typeof page.last === 'number' && page.last > after;
        if (moved) after = page.last;
        if (page.data.length < 500 || !moved) break;
      }
      if (!live) return;
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`agent ${this.id} is still ${this.status}`, this.id);
      await sleep(opts.pollMs ?? 2000);
      await this.client.pace();
    }
  }
}

/** A 410: the run is past its keep date. */
function isGone(err: unknown): boolean {
  return err instanceof MeshArcError && err.status === 410;
}

/**
 * The API base, ending in /api/v1. The key only travels over HTTPS: a plain
 * http:// base is refused unless it points at this machine, so a poisoned
 * MESHARC_API_URL cannot quietly send the key somewhere else in clear text.
 */
function baseUrlOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`baseUrl is not a URL: ${raw}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`baseUrl must be https:// (${raw}); http:// is allowed only for localhost.`);
  }
  return raw.replace(/\/+$/, '') + '/api/v1';
}

/** An id as one path segment, so it cannot reach another route. */
function seg(id: string): string {
  return encodeURIComponent(String(id));
}

function redact(key: string): string {
  return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : '…';
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

async function errorFrom(res: Response): Promise<MeshArcError> {
  const text = await res.text();
  let detail: unknown = text;
  let code = '';
  let requestId = res.headers.get('X-Request-Id') ?? '';
  try {
    const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown; code?: string; request_id?: string };
    detail = parsed.error ?? parsed.detail ?? text;
    code = parsed.code ?? '';
    requestId = parsed.request_id ?? requestId;
  } catch {
    // Not JSON; the text is the detail.
  }
  return new MeshArcError(res.status, detail, code, requestId);
}

/**
 * A date filter as the API reads it: a Date as its ISO string, a string as given. An invalid
 * Date throws a TypeError naming the filter, rather than the RangeError toISOString throws.
 */
function isoOf(name: string, value: string | Date | undefined): string | undefined {
  if (!(value instanceof Date)) return value;
  if (Number.isNaN(value.getTime())) throw new TypeError(`${name}: an invalid Date`);
  return value.toISOString();
}

/**
 * Every row of a cursor-paged list, page by page: `params` on every request,
 * and the cursor from each page's `next` until there is none.
 */
async function* paged<T>(client: MeshArc, path: string, params: Params): AsyncGenerator<T> {
  let cursor: string | undefined;
  for (;;) {
    const page = await client.call<{ data: T[]; next?: string | null }>('GET', path, undefined, { ...params, cursor });
    for (const row of page.data) yield row;
    if (!page.next) return;
    cursor = cursorOf(page.next);
    if (cursor === undefined) return;
  }
}

function cursorOf(next: string): string | undefined {
  const q = next.indexOf('?');
  if (q < 0) return undefined;
  return new URLSearchParams(next.slice(q + 1)).get('cursor') ?? undefined;
}
