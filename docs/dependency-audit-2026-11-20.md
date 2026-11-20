# Dependency audit and Next.js upgrade — 2026-11-20 UTC

Registry: public npm. Commands: `npm audit --json`, `npm audit --omit=dev --json`. Reports count **affected package entries**, not distinct advisory IDs. The lockfiles, reports, and application configuration were reviewed locally, not the currently deployed service.

| Snapshot | Critical | High | Moderate | Full raw report |
|---|---:|---:|---:|---|
| Before (Next.js 14.2.35) | 1 | 3 | 11 | [Before](audits/2026-11-20-before.json) |
| After (all dependencies) | 0 | 0 | 11 | [Full](audits/2026-11-20-full.json) |
| After (production only) | 0 | 0 | 0 | [Production](audits/2026-11-20-production.json) |

## Upgrade decision

Pin `next` and `eslint-config-next` to **15.5.29**, the then-current npm `next@backport` release. `next@latest` was **16.4.6** at audit time. The 15.5 backport is above all reported Next cutoffs, including GHSA-pc58-hwjq-p385 (`<=15.5.28`), and retains the current App Router architecture and React/React DOM 18.3.1. Upgrading to Next 16 is a separate maintenance item when backports no longer cover applicable advisories; this is not a promise of indefinite support. Migrated cookies to the async API and route params/page search params to promises. Existing Supabase, middleware, routes, provider integrations, PostgreSQL schema, and Business OS remain. Disabled unused framework image optimization explicitly. Node 22 is the tested baseline, aligned with the existing Render worker configuration.

## Baseline Next advisories and applicability

Every ID below refers to the [GitHub Advisory Database](https://github.com/advisories). The raw report includes full per-advisory ranges, severity and URL. The checked-in app has App Router pages, middleware redirects and a workspace Server Action. Do not use absence of an optional feature as a reason to stay on a vulnerable framework.

| Advisory IDs (baseline) | Relevance in this repository |
|---|---|
| GHSA-h25m-26qc-wcjf, GHSA-q4gf-8mx6-v5v3, GHSA-8h8q-6873-q5fj | RSC/App Router request handling is present; treat request DoS as relevant. |
| GHSA-m99w-x7hq-7vfj, GHSA-955p-x3mx-jcvp, GHSA-p3m5-59mp-jv5r | Server Actions are present (`create-workspace`); relevant framework surface. |
| GHSA-3g8h-86w9-wvmq, GHSA-vfv6-92ff-j949, GHSA-wfc6-r584-vfw7, GHSA-68g3-v927-f742, GHSA-4633-3j49-mh5q | Middleware redirects and RSC responses are present; proxy/CDN cache strategy and actual production impact were not verified. |
| GHSA-pc58-hwjq-p385 | Self-hosted fetched response forwarding. App connector routes parse data and construct their own responses, not direct forwarding of arbitrary fetched `Response` objects; hosting behavior was not verified. |
| GHSA-9g9p-9gw9-jx7f, GHSA-3x4c-7xq6-9pq8, GHSA-h64f-5h5j-jqjh, GHSA-2xp9-vwfh-vxw4, GHSA-2464-fhr4-w9xw | Framework optimizer advisories. No `next/image` imports or remote image/SVG optimizer settings were found; the framework endpoint cannot be presumed absent solely from that. The upgrade patches these and now explicitly disables optimization. |
| GHSA-ggv3-7p47-pfv8, GHSA-p9j2-gv94-2wf4, GHSA-c4j6-fc7j-m34r | No configured rewrites or application WebSocket upgrade handler found. Hosting and reverse-proxy behavior unknown. |
| GHSA-ffhc-5mcf-pf4q, GHSA-gx5p-jg67-6x7h, GHSA-36qx-fr4f-26g5 | No configured CSP nonce pipeline, `beforeInteractive` scripts using untrusted input, or Pages Router i18n found. |
| GHSA-89xv-2m56-2m9x, GHSA-4c39-4ccg-62r3, GHSA-p293-qw3h-jr36 | No custom Next server, Edge Server Action deployment, or Windows runtime evidenced in source/blueprint. Staging build used Linux and `next build`; live topology not verified. |

The high development-only package chain `eslint-config-next` → `@next/eslint-plugin-next` → `glob` flagged **GHSA-5j98-mcp5-4vw2** and **GHSA-3g3m-2fjr-6pw4**. The repository does not use the glob CLI's shell option in its scripts. The Next tooling update clears these entries (and the `glob` subpath to the minimatch advisory).

## Remaining 11 affected development package entries

| Advisory | Locked dependency chain | Exposure and follow-up |
|---|---|---|
| [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | `drizzle-kit` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → nested `esbuild` | Affects esbuild's dev-server API; normal Drizzle kit use here is local schema CLI, not serving a browser-accessible esbuild server. Do not expose an esbuild dev server. Move to a compatible patched migration-tool chain and verify SQL generation before rollout. |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Nested `minimatch` under `@typescript-eslint/typescript-estree`; audit also flags `@typescript-eslint/parser`, `@typescript-eslint/utils`, `@typescript-eslint/type-utils`, and `@typescript-eslint/eslint-plugin` | Development lint/file matching amplification; there is no production API passing patterns to this chain. Use trusted lint inputs and test against patched compatible lint dependencies rather than forcing a minimatch major override without validation. |
| [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) | `postcss-selector-parser` (Tailwind/build toolchain) | CPU amplification for untrusted selectors. No public CSS compiler route is checked in; do not accept untrusted CSS into shared builds. Upgrade/test a compatible build-tool chain. |

`npm audit --omit=dev` is a dependency-graph check, not proof that every deployment omits development dependencies or every attack surface is absent. Build on a trusted host, keep lint and migration tools out of runtime images when possible, and re-run both audits before promotion. No production deployment or hosting verification was performed.
