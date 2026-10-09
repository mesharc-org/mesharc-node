# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[SemVer](https://semver.org).

## Unreleased

### Added

- **Web search, so a script can find pages as well as read them.** `arc.webSearch(query, opts)` returns the results for a query — title, URL, snippet and the engine each came from — and, with `scrape`, each result's page too; it waits for the search to finish, and a search every engine refused resolves with status `blocked` rather than throwing. `news: true` reads the engines' news results instead, each with its `publisher` and `age`, and `page` (1 to 10) reads further in, page 2 being results 11 to 20. `arc.getSearch(id)` reads a search as it stands now, and `arc.searches({ q, limit })` yields the workspace's searches, newest first. The types `WebSearchOptions`, `WebSearchResult`, `WebSearchHit`, `SearchAttempt` and `SearchSummary` are exported. Needs the API's `/search` route, live on mesharc.dev, and a key that can write; `news` and `page` need an API with those features, on the API's feature branch and not yet on mesharc.dev.
- **The agent, so a script can ask a question and get an answer instead of reading pages itself.** `arc.agent(prompt, opts)` starts a run that searches, reads pages and answers — as JSON matching `schema` when one is given, `{ text }` otherwise — with the pages it drew on under `sources` and, for a schema answer, the page each value came from under `run.fieldSources`; `urls`, `allowedDomains`, `maxSteps` and `maxCredits` bound it, and a run that reaches `maxCredits` stops with status `credit_limit` and `{ partial }`. `webhook` (a URL, or `{ url, events, metadata }`) is told of the run's life, its signing secret `run.webhookSecret`, once; `connectionId` runs it on one of the workspace's own LLM connections. It resolves to an `AgentRun`: `wait()` resolves at `done`, `cancelled` or `credit_limit` and throws on `error`, `refresh()` reads it now, `trace()` yields its steps as they happen, `cancel()` asks it to stop, and `continue({ maxCredits, maxSteps, apiTimeoutS, idempotencyKey })` carries on a run stopped at `credit_limit` as a new run on the same thread, which keeps the stopped run's webhook and `webhookSecret` (409 `conflict` for a run that cannot be continued, 410 `expired` past its keep date, 400 when its LLM connection can no longer be used). `run.continuesRunId` / `run.continuedBy` link a run to the one it carried on and the one that carried it on. `arc.getAgent(id)` reattaches to a run, throwing `MeshArcError` 410 with code `expired` once it is past its 7 days, and `arc.agentRuns({ status, model, since, until, limit })` yields the workspace's runs, newest first; `since` / `until` take a string or a `Date`, and an invalid `Date` throws a `TypeError` before any request. The types `AgentOptions`, `AgentEnvelope`, `AgentSource`, `AgentFieldSource`, `AgentEvent`, `AgentTrace`, `AgentSummary`, `AgentStatus`, `AgentContinueOptions`, `AgentRunsOptions` and `WebhookSpec` are exported. Needs an API with the `/agent` route, which is not live on mesharc.dev yet, and a key that can write; `webhook`, `connectionId`, `continue()` and `fieldSources` need an API with those features, on the API's feature branch and not yet on mesharc.dev.
- **Monitors, so a script can ask a search or a question again on a schedule and hear when the answer changes.** A namespace beside `arc.projects` and `arc.runs`: `arc.monitors.create(kind, request, schedule, { name, webhook, baselineId, idempotencyKey })` keeps a search or an agent request and runs it hourly, daily or weekly, each run compared with the last one that answered; its webhook hears `search.changed` / `agent.changed`. `request` is typed by kind — a `SearchMonitorRequest` (`query`, `limit`, `sources`, `page`, `country`, `lang`, `freshness`, `includeDomains`, `excludeDomains`; a news monitor is `sources: ['news']`, and there is no `scrape`) or an `AgentMonitorRequest` (`prompt`, `urls`, `schema`, `maxCredits`, `maxSteps`, `allowedDomains`, `connectionId`) — so a `webSearch` option such as `news: true` is a type error rather than silently ignored. `monitors.list({ kind })`, `get`, `update`, `pause`, `resume`, `run` (409 `conflict` while a run is under way, 402 `credits_exhausted` when the credits are spent), `runs(id, { limit })`, which yields the runs newest first, and `delete` manage them. `arc.monitor()`, the job queue, is unchanged. The types `Monitors`, `Monitor`, `MonitorRun`, `MonitorKind`, `MonitorSchedule`, `SearchMonitorRequest`, `AgentMonitorRequest`, `CreateMonitorOptions` and `MonitorUpdate` are exported. Needs an API with the `/monitors` route, on the API's feature branch and not yet on mesharc.dev, and a key that can write.

### Changed

- **Breaking for code that told the two apart by class:** `MeshArcTimeoutError` now extends `MeshArcError`, with status 0 and code `timeout`, so a `catch` that checks `instanceof MeshArcError` first now also catches job timeouts. Tell them apart with `instanceof MeshArcTimeoutError` (checked first) or by `jobId`. The message is unchanged.

### Fixed

- `call()` on a 200 response with an empty body resolves to `undefined` instead of throwing a `SyntaxError`.
- The README and the `agent()` docs say what an agent run's tokens cost: the model provider's price plus 20%, or 1 credit per 1,000 tokens on the workspace's own connection. They said "the LLM rate".
- The README's error table lists `credits_exhausted` (402), the code the API sends when the workspace's credits are spent; it said `plan_limit` covered that.
- The `ExportOptions` types list every dataset and format the API offers: `rows`, `row-events`, `llms` and `llms-full` beside the earlier five, and `txt` beside `jsonl` and `csv`.

## 0.2.0 - 2026-09-28

### Added

- The client paces itself against the API key's rate limit. When a response's `X-RateLimit-Remaining` header shows the key is almost out of requests, the next request and the waiting loops hold until the window resets instead of being refused. `arc.pace()` does the same wait on demand.

### Changed

- Requires Node 20 or newer. Node 18 reached its end of life in April 2025.

### Fixed

- TypeScript projects that load the package with `require()` get the CommonJS type declarations. They were given the ESM ones before.

## 0.1.3

- The API key is kept private: it is never printed by `console.log` or `util.inspect`.
- The base URL must be `https://`; plain `http://` is accepted only for `localhost`, so the key is never sent in clear text.
- Ids are sent as single URL path segments, so an id can never reach another route.
- `SECURITY.md`: how to report a vulnerability, and what the client does with your data.

## 0.1.2

- Requests time out (150 s by default; `timeoutMs`) and are retried on 429, 502, 503, 504 and network failures when safe to repeat (`maxRetries`, default 2), honouring `Retry-After`.
- `MeshArcTimeoutError` for a job the client stopped waiting for; it carries the job id.
- Network and timeout failures throw `MeshArcError` with status 0 and code `network` / `timeout`.
- Typed option objects for `crawl`, `map`, `scrape`, `export` and `createKey`.
- A CommonJS build beside the ESM one (`require('mesharc')` works).
- `raw()` shares the transport with `call()`: the same headers, errors and retries.

## 0.1.1

- The README, reorganised; the client needs only an API key.

## 0.1.0

- First release.
