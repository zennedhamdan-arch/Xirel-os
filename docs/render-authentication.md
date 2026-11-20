# Restore production authentication on Render

**Canonical production application:** `https://xirel-os.onrender.com`
**Application callback:** `https://xirel-os.onrender.com/api/auth/callback`

## Diagnosis and change

The previous login page constructed both Supabase `redirectTo` (GitHub) and `emailRedirectTo` (magic link) from `NEXT_PUBLIC_APP_URL`. Next.js inlines public variables in the browser build, so changing only a running process's environment does not fix a bundle built with the retired `xirel-os-rwgv.vercel.app` value. Historical repo guides explicitly listed that value. The callback and middleware also derived redirect origins from the incoming request, and the login page did not pass through a protected route's return path. There were no other `*.vercel.app` deployment URLs in the repository search.

The live Render environment and the managed Supabase dashboard were not available for inspection. A stale value in the deployed bundle is a direct code path to the symptom, not proof of which live setting triggered it. In particular, [Supabase Auth's redirect selection](https://github.com/supabase/auth/blob/master/internal/utilities/request.go) can fall back to Site URL when the requested target and referrer are not accepted, so verify both services. The committed Render blueprint describes a background worker, not the deployed web service. The two normal Supabase clients share the configured public project URL and anon key; only the SSR client/middleware writes redirect-session cookies on the server. The Business Suite still supports password sign-in.

The fix uses server-side `APP_URL` for authentication, defaults production to Render, and refuses the retired hostname as an auth origin. The application never uses `Host`, `X-Forwarded-Host`, or a user-supplied URL as a redirect origin. Login moves to the trusted origin **before** starting PKCE. Middleware preserves the requested local path and query, callback exchanges a valid code (or an optional custom-template email token hash) for a session, and logout returns to the same trusted `/login`. External/invalid return paths fall back to `/dashboard`.

## 1. Render → Xirel OS **web service** → Environment

| Variable | Production value/action |
| --- | --- |
| `APP_URL` | **`https://xirel-os.onrender.com`**. Set on the web service. This is a server-side origin, not a secret; login receives only the validated origin. |
| `NEXT_PUBLIC_APP_URL` | **`https://xirel-os.onrender.com`**. Align the old public setting for integration metadata, including the OpenRouter referrer. It no longer controls auth. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Keep the existing production project's matching values. Verify the configured project is the project you update in the next step. Do not rotate or expose keys for this fix. |
| `AUTH_GOOGLE_ENABLED` | Leave unset unless Google is already configured and verified in that Supabase project. Set `true` to expose Google on the login screen after verifying its provider settings. GitHub remains unchanged by default. |

**A manual Render web build and redeploy is needed** to ship the code and update any public values baked into assets. Update the dashboard settings and deploy in the same maintenance window. No worker redeployment or database migration is required for this change. Give development or staging its own trusted `APP_URL` and preferably its own Supabase project; loopback HTTP is allowed only outside production mode.

## 2. Supabase → Authentication → URL Configuration

1. Set **Site URL** to **`https://xirel-os.onrender.com`**. This is the fallback application origin, not the Supabase API or an OAuth provider URL.
2. Add the exact **Redirect URL** **`https://xirel-os.onrender.com/api/auth/callback`**. The production site's same origin also admits the callback's optional `?redirectTo=…` query. Test it with a protected URL such as `/command?workspace=<authorized-workspace-id>`; no broad wildcard is needed for production. For separate staging, set that project's Site URL to the staging origin and add its exact callback. For local Supabase-assisted development, retain/add `http://localhost:3000/api/auth/callback` only if it is intentionally used.
3. Inventory the existing redirects first. Retain legitimate entries for other clients or staging that still need them. Remove any redirect rule that permits the retired application or a broad Vercel wildcard **once you confirm it is not required by any remaining client**. Do not remove the provider callback below.

## 3. Google and GitHub settings: keep the two callbacks distinct

- In **Supabase → Authentication → Sign In / Providers**, use the provider's displayed **Callback URL** (usually `https://<project-ref>.supabase.co/auth/v1/callback`, or the configured custom Supabase Auth domain). Preserve the existing client IDs/secrets.
- **Google Cloud Console → OAuth Web Client → Authorized redirect URIs:** keep that **Supabase Auth callback**. The Render `/api/auth/callback` is not a substitute. Only add/update the Supabase value if it is missing or the Supabase Auth domain changed. This flow does not use a browser-side Google sign-in SDK, so it does not require adding Render as a Google JavaScript origin solely for this fix.
- **GitHub → Settings → Developer settings → OAuth Apps → the app used by Supabase:** keep **Authorization callback URL** equal to the **Supabase Auth callback**. If the displayed **Homepage URL** still points to Vercel, update it to `https://xirel-os.onrender.com`; that is metadata, not the OAuth redirect URI. Do not change the OAuth application or its credentials just for an application host move.
- In **Authentication → Email Templates**, inspect **Magic Link** and **Confirm signup** for literal old URLs. The default `{{ .ConfirmationURL }}` should stay: it invokes Supabase verification and then the validated application callback. When a custom email template intentionally bypasses that default, the callback also accepts `token_hash={{ .TokenHash }}` with `type=email`. Do not add a second `?` to a URL that already has query parameters or replace confirmation with a plain link to `/login`. No template change is needed if already using the default. Send **fresh** links after the change; old links may still point to the retired host. Use the launching browser for default PKCE links so the code verifier is available.

## Verification and release checklist

- Local: `npm run test:auth` runs the real Supabase client request construction with substituted network/auth responses, route handler and middleware tests (including unsafe return targets and spoofed host headers), and logout navigation tests. `npm run test:staging-web` after a production build verifies that a stale public Vercel value does not affect HTTP redirects or the login page. Hosted OAuth, inbox delivery and real session creation were **not** tested here.
- After the manual deploy, start in a fresh browser at `https://xirel-os.onrender.com/command` and also try `/chat?workspace=<authorized-workspace-id>`. Confirm the login URL carries the same local destination and the authenticated session returns there. Test GitHub, Google if configured, a freshly generated email link, dashboard logout, and Business Suite password sign-in/logout. Confirm all **application** redirects use Render (visiting Supabase and the OAuth provider mid-flow is expected). Test denial/expiry and an external `redirectTo` value; callback failure should land on Render login, while successful sign-in with an invalid target should land on Render dashboard. Do not capture callback codes, token hashes, email links, or session cookies in shared logs.
