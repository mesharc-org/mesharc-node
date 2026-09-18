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

export const VERSION = '0.1.2';

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

/** A job that was still running when the client stopped waiting for it. */
export class MeshArcTimeoutError extends Error {
  /** The job that is still running; poll it later with the matching `get*` method. */
  readonly jobId: string;

  constructor(message: string, jobId = '') {
    super(message);
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
  /** The API's base URL. Used by MeshArc's own test environments; the hosted API needs nothing here. */
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

  private readonly base: string;
  private readonly key: string;
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
    this.key = key;
    this.base = (options.baseUrl ?? readEnv('MESHARC_API_URL') ?? DEFAULT_BASE).replace(/\/+$/, '') + '/api/v1';
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('No fetch available: use Node 18+ or pass { fetch }.');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.projects = new Projects(this);
    this.runs = new Runs(this);
  }

  // ---------------------------------------------------------------- transport

  /** Any API route. Resolves to the parsed JSON body (undefined for 204). */
  async call<T = Json>(method: string, path: string, body?: unknown, params?: Params, idempotencyKey?: string): Promise<T> {
    const res = await this.request(method, path, body, params, idempotencyKey);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Any API route, resolving to the raw Response — for streamed bodies such as exports. */
  raw(method: string, path: string, body?: unknown, params?: Params, idempotencyKey?: string): Promise<Response> {
    return this.request(method, path, body, params, idempotencyKey);
  }

  private async request(method: string, path: string, body?: unknown, params?: Params, idempotencyKey?: string): Promise<Response> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      'User-Agent': `mesharc-node/${VERSION}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    // A GET or DELETE is safe to repeat; a POST only when it carries an idempotency key.
    const repeatable = method === 'GET' || method === 'DELETE' || !!idempotencyKey;

    for (let attempt = 0; ; attempt++) {
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
      if (res.status < 400) return res;
      if (RETRY_STATUSES.has(res.status) && repeatable && attempt < this.maxRetries) {
        await sleep(retryAfterMs(res) ?? backoff(attempt));
        continue;
      }
      throw await errorFrom(res);
    }
  }

  // --------------------------------------------------------- one or many URLs

  /** One URL with every format, as the app's playground reads it. Resolves to the finished extraction. */
  async extract(url: string, config?: Config, opts: WaitOptions = {}): Promise<Json> {
    const job = await this.call<{ id: string }>('POST', '/playground/extract', config ? { url, config } : { url });
    if (opts.wait === false) return job;
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    for (;;) {
      const r = await this.call<{ status: string }>('GET', `/playground/${job.id}`);
      if (!isRunning(r.status)) return r;
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`extraction ${job.id} is still ${r.status}`, job.id);
      await sleep(opts.pollMs ?? 2000);
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
      out = await this.call<ScrapeEnvelope>('GET', `/scrape/${out.id}`, undefined, { formats });
    }
  }

  /** A batch started earlier. With `wait`, resolves once every row is in. */
  async batch(batchId: string, opts: { formats?: string } & WaitOptions = {}): Promise<Json> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
    for (;;) {
      const r = await this.call<{ status: string }>('GET', `/scrape/${batchId}`, undefined, { formats: opts.formats ?? 'markdown' });
      if (!opts.wait || !isRunning(r.status)) return r;
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`batch ${batchId} is still ${r.status}`, batchId);
      await sleep(opts.pollMs ?? 3000);
    }
  }

  // ------------------------------------------------------------ a whole site

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
    return new Crawl(this, await this.call('GET', `/crawl/${crawlId}`, undefined, { limit: 1 }));
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
      out = await this.call('GET', `/map/${out.id}`, undefined, { search, limit });
    }
    if (out.status !== 'done') throw new MeshArcError(502, out.error ?? 'no sitemap could be read', 'job_failed');
    return out;
  }

  // ------------------------------------------------------- what a project holds

  /** The pages of a run (the latest finished run by default). */
  pages(projectId: string, runId?: string): Promise<Json> {
    return this.call('GET', `/projects/${projectId}/pages`, undefined, { run_id: runId });
  }

  /** One page in full: bodies, head fields, structured fields, versions. */
  page(projectId: string, url: string, runId?: string): Promise<Json> {
    return this.call('GET', `/projects/${projectId}/pages/content`, undefined, { url, run_id: runId });
  }

  /** The change record of a run against the run before it. */
  changes(projectId: string, runId?: string): Promise<Json> {
    return this.call('GET', `/projects/${projectId}/changes`, undefined, { run_id: runId });
  }

  /** The word-level diff of one page against the run before. */
  pageDiff(projectId: string, url: string, runId?: string): Promise<Json> {
    return this.call('GET', `/projects/${projectId}/changes/page`, undefined, { url, run_id: runId });
  }

  /** Which pages say this (`content`: words, "phrases") or contain this (`selector`: CSS or XPath). */
  search(projectId: string, q: string, mode: 'content' | 'selector' = 'content', runId?: string): Promise<Json> {
    return this.call('POST', `/projects/${projectId}/pages/search`, { mode, q, run_id: runId });
  }

  /** Fetch these pages again now, as a scoped run. */
  recrawl(projectId: string, urls: string[]): Promise<Json> {
    return this.call('POST', `/projects/${projectId}/pages/recrawl`, { urls });
  }

  /** The seed, sitemap, URL list, feeds and patterns, with what the last run found through each. */
  sources(projectId: string): Promise<Json> {
    return this.call('GET', `/projects/${projectId}/sources`);
  }

  /** A dataset as a stream. Resolves to the Response; read `.body`, `.text()` or pipe it. */
  export(projectId: string, opts: ExportOptions = {}): Promise<Response> {
    const dataset = opts.dataset ?? 'pages';
    const format = opts.format ?? 'jsonl';
    if (opts.urls) {
      return this.raw('POST', `/projects/${projectId}/export`, { dataset, format, run_id: opts.runId, urls: opts.urls });
    }
    return this.raw('GET', `/projects/${projectId}/export`, undefined, { dataset, format, run_id: opts.runId });
  }

  // ---------------------------------------------------------------- workspace

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
    return this.call<void>('DELETE', `/me/keys/${keyId}`);
  }

  usage(): Promise<Json> {
    return this.call('GET', '/me/usage');
  }

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

export interface ExportOptions {
  dataset?: 'pages' | 'markdown' | 'changes' | 'fields' | 'sitemap';
  format?: 'jsonl' | 'csv';
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
    return this.client.call('GET', `/projects/${projectId}`);
  }

  update(projectId: string, fields: Json): Promise<Json> {
    return this.client.call('PATCH', `/projects/${projectId}`, fields);
  }

  delete(projectId: string): Promise<void> {
    return this.client.call<void>('DELETE', `/projects/${projectId}`);
  }
}

export class Runs {
  constructor(private readonly client: MeshArc) {}

  list(projectId: string, limit = 25): Promise<Json[]> {
    return this.client.call<Json[]>('GET', `/projects/${projectId}/runs`, undefined, { limit });
  }

  get(projectId: string, runId: string): Promise<Json> {
    return this.client.call('GET', `/projects/${projectId}/runs/${runId}`);
  }

  async start(projectId: string, opts: WaitOptions = {}): Promise<Json> {
    const run = await this.client.call<{ id: string }>('POST', `/projects/${projectId}/runs`, { trigger: 'api' });
    return opts.wait ? this.wait(projectId, run.id, opts) : run;
  }

  async wait(projectId: string, runId: string, opts: WaitOptions = {}): Promise<Json> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
    for (;;) {
      const run = await this.get(projectId, runId);
      if (run.status !== 'running' && !run.queued) return run;
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`run ${runId} is still ${String(run.status)}`, runId);
      await sleep(opts.pollMs ?? 3000);
    }
  }

  cancel(projectId: string, runId: string): Promise<Json> {
    return this.client.call('POST', `/projects/${projectId}/runs/${runId}/cancel`);
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
    this.envelope = await this.client.call('GET', `/crawl/${this.id}`, undefined, { limit: 1, formats });
    return this.envelope;
  }

  async wait(opts: WaitOptions & { formats?: string } = {}): Promise<Json> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3_600_000);
    for (;;) {
      const e = await this.refresh(opts.formats);
      if (!isRunning(e.status)) return e;
      if (Date.now() > deadline) throw new MeshArcTimeoutError(`crawl ${this.id} is still ${String(e.status)}`, this.id);
      await sleep(opts.pollMs ?? 3000);
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
        'GET', `/crawl/${this.id}`, undefined, { formats: opts.formats ?? 'markdown', limit: opts.limit ?? 25, cursor },
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
    }
  }

  /** Make this one-shot crawl a project. Its run and pages are already in place. */
  keep(opts: { name?: string; schedule?: string; retention?: string } = {}): Promise<Json> {
    return this.client.call('POST', `/crawl/${this.id}/keep`, opts);
  }

  async cancel(): Promise<Json> {
    await this.client.call<void>('DELETE', `/crawl/${this.id}`);
    this.envelope = { ...this.envelope, status: 'cancelled' };
    return this.envelope;
  }
}

// ------------------------------------------------------------------ helpers

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

function cursorOf(next: string): string | undefined {
  const q = next.indexOf('?');
  if (q < 0) return undefined;
  return new URLSearchParams(next.slice(q + 1)).get('cursor') ?? undefined;
}
