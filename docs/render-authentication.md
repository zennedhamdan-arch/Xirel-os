# Restore production authentication on Render

**Canonical production application:** `https://xirel-os.onrender.com`
**Application callback:** `https://xirel-os.onrender.com/api/auth/callback`

## Earlier redirect issue and current login-loop findings

The previous login page constructed both Supabase `redirectTo` (GitHub) and `emailRedirectTo` (magic link) from `NEXT_PUBLIC_APP_URL`. Next.js inlines public variables in the browser build, so changing only a running process's environment does not fix a bundle built with the retired `xirel-os-rwgv.vercel.app` value. Historical repo guides explicitly listed that value. The callback and middleware also derived redirect origins from the incoming request, and the login page did not pass through a protected route's return path. There were no other `*.vercel.app` deployment URLs in the repository search.

The Render web service environment and deployed revision were not available for inspection. A stale value in the deployed bundle is one possible explanation for the earlier cross-host symptom. In particular, [Supabase Auth's redirect selection](https://github.com/supabase/auth/blob/master/internal/utilities/request.go) can fall back to Site URL when the requested target and referrer are not accepted, so verify both services. The committed Render blueprint describes a background worker, not the deployed web service. The two normal Supabase clients share the configured public project URL and anon key; only the SSR client/middleware writes redirect-session cookies on the server. The Business Suite still supports password sign-in.

The fix uses server-side `APP_URL` for authentication, defaults production to Render, and refuses the retired hostname as an auth origin. The application never uses `Host`, `X-Forwarded-Host`, or a user-supplied URL as a redirect origin. Login moves to the trusted origin **before** starting PKCE. Middleware preserves the requested local path and query, callback exchanges a valid code (or an optional custom-template email token hash) for a session, and logout returns to the same trusted `/login`. External/invalid return paths fall back to `/dashboard`.

### Render login loop — 2026-11-20

- Verified that the public Render login page offers GitHub. The linked Supabase project (`mzvnlmvnowmrunbaqifi`) had GitHub enabled, the retired Vercel origin as Site URL, and only that Vercel origin's wildcard in the redirect list. An explicit Render callback did not match that configuration and could be replaced by a fallback. Updated the live Supabase Site URL to the Render origin and added the exact Render callback; retained the existing wildcard for operator inventory. No provider credentials were changed as part of the host correction.
- This was a confirmed redirect mismatch, **not** a confirmed explanation for a flow that returns to Render and then `/login`. The sandbox Chromium could not reach Render directly, and no authenticated GitHub browser session was available. The deployed SDK handoff, real callback parameters/exchange, session persistence, and dashboard recognition remain unverified. A public page displaying the login button does not verify its client-side configuration.
- For this project, the expected **provider** callback registered with GitHub is `https://mzvnlmvnowmrunbaqifi.supabase.co/auth/v1/callback`. Check it in the GitHub OAuth app and compare only the origin/path requested by Supabase on the browser handoff. Do not copy the authorization URL or OAuth state. This check and the Render environment check require operator access.

## 1. Render → Xirel OS **web service** → Environment

| Variable | Production value/action |
| --- | --- |
| `APP_URL` | **`https://xirel-os.onrender.com`**. Set on the web service. This is a server-side origin, not a secret; login receives only the validated origin. |
| `NEXT_PUBLIC_APP_URL` | **`https://xirel-os.onrender.com`**. Align the old public setting for integration metadata, including the OpenRouter referrer. It no longer controls auth. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Keep the existing production project's matching values. Verify the configured project is the project you update in the next step. Do not rotate or expose keys for this fix. |
| `AUTH_DIAGNOSTICS` | After an approved web rollout of the diagnostics, set `true` temporarily; unset it after reproducing. No secret values are logged by these diagnostics. |
| `AUTH_GOOGLE_ENABLED` | Leave unset unless Google is already configured and verified in that Supabase project. Set `true` to expose Google on the login screen after verifying its provider settings. GitHub remains unchanged by default. |

**An approved manual Render web build and redeploy is needed** to ship code changes or update public values baked into assets. The Supabase URL correction is already live and does not require an application deploy. Check the deployed revision before deciding whether a rebuild is needed. No worker redeployment or database migration is required for this change. Give development or staging its own trusted `APP_URL` and preferably its own Supabase project; loopback HTTP is allowed only outside production mode.

## 2. Supabase → Authentication → URL Configuration

1. Set **Site URL** to **`https://xirel-os.onrender.com`**. This is the fallback application origin, not the Supabase API or an OAuth provider URL.
2. Add the exact **Redirect URL** **`https://xirel-os.onrender.com/api/auth/callback`**. The production site's same origin also admits the callback's optional `?redirectTo=…` query. Test it with a protected URL such as `/command?workspace=<authorized-workspace-id>`; no broad wildcard is needed for production. For separate staging, set that project's Site URL to the staging origin and add its exact callback. For local Supabase-assisted development, retain/add `http://localhost:3000/api/auth/callback` only if it is intentionally used.
3. Inventory the existing redirects first. Retain legitimate entries for other clients or staging that still need them. Remove any redirect rule that permits the retired application or a broad Vercel wildcard **once you confirm it is not required by any remaining client**. Do not remove the provider callback below.

## 3. Google and GitHub settings: keep the two callbacks distinct

- In **Supabase → Authentication → Sign In / Providers**, use the provider's displayed **Callback URL** (usually `https://<project-ref>.supabase.co/auth/v1/callback`, or the configured custom Supabase Auth domain). Preserve the existing client IDs/secrets.
- **Google Cloud Console → OAuth Web Client → Authorized redirect URIs:** keep that **Supabase Auth callback**. The Render `/api/auth/callback` is not a substitute. Only add/update the Supabase value if it is missing or the Supabase Auth domain changed. This flow does not use a browser-side Google sign-in SDK, so it does not require adding Render as a Google JavaScript origin solely for this fix.
- **GitHub → Settings → Developer settings → OAuth Apps → the app used by Supabase:** keep **Authorization callback URL** equal to the **Supabase Auth callback**. If the displayed **Homepage URL** still points to Vercel, update it to `https://xirel-os.onrender.com`; that is metadata, not the OAuth redirect URI. Do not change the OAuth application or its credentials just for an application host move.
- In **Authentication → Email Templates**, inspect **Magic Link** and **Confirm signup** for literal old URLs. The default `{{ .ConfirmationURL }}` should stay: it invokes Supabase verification and then the validated application callback. When a custom email template intentionally bypasses that default, the callback also accepts `token_hash={{ .TokenHash }}` with `type=email`. Do not add a second `?` to a URL that already has query parameters or replace confirmation with a plain link to `/login`. No template change is needed if already using the default. Send **fresh** links after the change; old links may still point to the retired host. Use the launching browser for default PKCE links so the code verifier is available.

## Triage one fresh GitHub attempt

Use the same browser profile and tab from initiation to return. Stop other concurrent login attempts while isolating the failure. In browser DevTools, inspect whether each expected cookie or header is **present**, without exporting a HAR, sharing screenshots, copying values, or retaining OAuth URLs with queries. Filter the Render web logs for `scope=xirel_auth`. Callback arrival and result share a generated ID; middleware and the Dashboard Server Component share a different per-request ID. Match the callback to the next navigation by timing, not by assuming those IDs will match across the redirect.

| Observation | Next check |
| --- | --- |
| No `callback_arrival` on the instrumented revision | Check runtime origin and the browser's `redirect_to` origin/path; confirm the Supabase Site URL, allowlist and GitHub provider callback. |
| `codePresent=false` or `provider_reported_error` | Confirm whether Supabase sent an OAuth code to the Render callback; investigate approved provider diagnostics, without copying query data. |
| `pkceCookiePresent=false` and `exchange_failed` / `pkce_verifier_missing` | Check that a verifier was created on Render and sent on the **top-level** Render callback; check browser privacy controls, domain/path, and whether the attempt changed browser or overlapped another login. Cookie presence alone does not prove verifier validity. |
| `exchange_failed` with `bad_code_verifier`, `flow_state_not_found`, or `flow_state_expired` | Retry from a fresh login once; confirm the exchange used the correct project's fresh flow, not a reused callback or mismatched verifier. |
| Exchange succeeds but no session cookie writes or `cookieWriteFailed=true` | Check the callback response and whether its `Set-Cookie` headers contain a session cookie. `sessionCookiesWritten` counts successful non-deletion writes of session cookies/chunks to Next's response cookie store; it does not prove delivery through Render or acceptance by the browser. |
| Callback response sends cookies, but middleware has `sessionCookiesReceived=0` | Check browser acceptance and transmission to the next protected request. Verify cookie domain, path, SameSite, and HTTPS configuration. |
| Middleware has cookies but `userRecognized=false` | Check the allowlisted SDK error and whether browser, callback, and middleware use the same Supabase project and public key. Distinguish `protected_route_requires_user` from a login redirect for an already recognized user. |
| Middleware recognizes a user, but dashboard doesn't | Match the middleware/dashboard IDs and compare the dashboard cookie count and safe SDK error. `authenticated_user_has_no_workspace` means the user **was** recognized and was sent to onboarding, not rejected by authentication. |

Never log raw SDK errors or paste tokens, callback codes, request URLs with queries, credentials, or cookie names/values into a support ticket. Presence flags for `APP_URL`, `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` do not prove their correctness; verify the two public settings at build time as well as on the running Render service.

## Verification and release checklist

- Local Chromium reached the production build through a loopback HTTPS proxy with a simulated Auth provider. It stored a PKCE verifier, sent it on the callback, and the provider matched it against the challenge. The response emitted a session cookie, Chromium retained and sent it on `/dashboard`, and both middleware and the Dashboard Server Component recognized the simulated user with the same request ID. The dashboard's workspace query could not render without a database in this fixture. This is not a real GitHub or Supabase sign-in.

- Local: `npm run test:auth` runs the real Supabase client request construction with substituted network/auth responses, route handler and middleware tests (including unsafe return targets and spoofed host headers), and logout navigation tests. `npm run test:staging-web` after a production build verifies that a stale public Vercel value does not affect HTTP redirects or the login page. Hosted OAuth, inbox delivery and real session creation were **not** tested here.
- After the manual deploy, start in a fresh browser at `https://xirel-os.onrender.com/command` and also try `/chat?workspace=<authorized-workspace-id>`. Confirm the login URL carries the same local destination and the authenticated session returns there. Test GitHub, Google if configured, a freshly generated email link, dashboard logout, and Business Suite password sign-in/logout. Confirm all **application** redirects use Render (visiting Supabase and the OAuth provider mid-flow is expected). Test denial/expiry and an external `redirectTo` value; callback failure should land on Render login, while successful sign-in with an invalid target should land on Render dashboard. Do not capture callback codes, token hashes, email links, or session cookies in shared logs.
