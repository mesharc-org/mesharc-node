# Changelog

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
