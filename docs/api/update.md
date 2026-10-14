# npm-compatible update metadata

This is a CLI distribution API, independent of the gateway and Mi Home cloud.
No gateway session, cloud credentials or npm authentication are sent.

## Request

`GET <registry>/@eyaeya%2fxgg-cli/<version>` with `Accept: application/json`.
`<version>` is `latest` or an exact stable `major.minor.patch`. Default sources:

1. `https://registry.npmjs.org`
2. `https://registry.npmmirror.com` after the first source fails

An explicit `--registry` / `XGG_UPDATE_REGISTRY` selects only that registry.
HTTPS URLs may include a base path but cannot include credentials, query or
fragment. Redirects are rejected. Each request, including its response body, has
a 2.5-second default deadline and a 1 MiB decoded-body limit. Failures include
network/HTTP errors, timeout, invalid JSON, and a rejected manifest schema.
Raw exception strings, response bodies, and invalid registry URLs are not emitted.

## Response contract

`packages/core/src/schemas/update.ts` exports `UpdatePackageMetadata`:

| Field | Contract |
| --- | --- |
| `name` | Exactly `@eyaeya/xgg-cli` |
| `version` | Stable `major.minor.patch`; no prerelease, build suffix, leading zero, or unsafe integer component |
| `dependencies.@eyaeya/xgg-core` | Same version, exact or prefixed by `^` or `~`; installer pins the core version |
| `engines.node` | Optional nonempty range string, passed through for the installer compatibility gate |
| `dist.tarball` | HTTPS URL without credentials, query or fragment |
| `dist.integrity` | SHA-512 SRI value |

Unused manifest fields are stripped. An exact-version fetch additionally verifies
the returned version matches the requested version. Version comparisons are
numeric; a lagging source never causes a downgrade. The first valid source wins.
Mirror results explicitly warn that metadata may lag and freshness is unverified;
an offline check throws, never returns a false “up to date” result.

## Evidence and verification

Both manifests were read from the public version endpoints on 2026-10-14. The
fixtures retain only needed public metadata and dependencies; npm signatures,
provenance, publisher details and other unused fields were omitted:

- `fixtures/responses/update/npm-latest.json`
- `fixtures/responses/update/npmmirror-latest.json`

`packages/core/tests/contract/update.test.ts` registers both fixtures and unsafe
manifest rejection cases. CLI unit tests inject fake fetch responses for source
ordering, fallback, lag, exact version checks, URL validation, body limits,
timeouts, numeric versions and sanitized failures. Live reachability is evidence
for the tested network only; neither source is guaranteed on every mainland ISP.
