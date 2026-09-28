# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[SemVer](https://semver.org).

## Unreleased

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
