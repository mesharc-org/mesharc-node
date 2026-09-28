# Contributing

Thanks for helping with the MeshArc Node client. This repository is the only home of the
package that is published to npm as `mesharc`.

## Set up

Node 20 or newer.

```bash
npm ci
npm run build
```

To try the client against an API running on your own machine, point it there (plain `http://`
is accepted only for localhost):

```bash
export MESHARC_API_URL=http://localhost:8010
```

To use your working copy from another project, run `npm link` here and `npm link mesharc` there.

## Checks

These are what CI runs on every pull request, on Node 20, 22 and 24:

```bash
npm run build
npm test
npx publint                  # package.json and the published files
npx attw --pack .            # the ESM and CommonJS builds each get the right types
node scripts/check-release.mjs     # the version is the same in package.json and src/index.ts
```

## Pull requests

- Work on a branch and open a pull request against `main`. `main` only changes through pull
  requests whose checks pass, and every pull request is squash-merged.
- Keep a pull request to one change, with tests for it.
- Add a line under `## Unreleased` in `CHANGELOG.md` for anything a user of the client will
  notice. Internal changes (tests, CI) need no entry.
- Only add an option once the live API at mesharc.dev accepts it. The client must never offer
  something production refuses.
- Comments: JSDoc on the public API, since it is the help users see in their editor. Inline
  comments only where the reason for the code is not obvious.

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), not in an
issue.

## Releasing (maintainers)

Releases are published from a tag, by `.github/workflows/release.yml`, through npm trusted
publishing. No token is stored anywhere, and npm attaches provenance to every release.

1. In one pull request, set the new version in `package.json` and `VERSION` in `src/index.ts`,
   and rename `## Unreleased` in `CHANGELOG.md` to that version, leaving a fresh empty
   `## Unreleased` above it.
2. After it is merged, tag the merge commit and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The workflow checks that the tag, the version and the changelog agree, tests, builds and
   packs the package, then waits for an owner to approve the `npm` environment. Once approved it
   publishes to npm and creates the GitHub Release from the changelog section.

Versioning follows [SemVer](https://semver.org). While the version is 0.x, a minor release may
contain breaking changes, and the changelog says so. A Node version is supported until six months
after its upstream end of life; dropping one is a minor release with a changelog entry.

To rehearse a release without publishing, run the Release workflow by hand (Actions → Release →
Run workflow). It checks, tests, builds and packs the package, and publishes nothing.
