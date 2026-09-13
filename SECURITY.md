# Security Policy

## Reporting a vulnerability

Please report security issues privately using GitHub's [private vulnerability reporting](https://github.com/danpillay87/mcp-yoto/security/advisories/new) on this repository, rather than opening a public issue. That reaches Dan Pillay directly. You'll get an acknowledgement, and a fix or mitigation timeline once the report is triaged.

Please do **not** post credentials, tokens, or real Yoto account details in an issue, PR, or advisory — describe the issue and how to reproduce it instead.

## Scope

In scope:

- `apps/worker` — the remote MCP server and its OAuth handling (`src/upstream.ts`, `src/refresh.ts`, the `@cloudflare/workers-oauth-provider` wiring).
- `apps/cli` — the local stdio server, its PKCE loopback flow, and its token storage.
- `packages/core` — the shared Yoto client and tool definitions.

Out of scope:

- Yoto's own API, login pages, or infrastructure (`login.yotoplay.com`, `api.yotoplay.com`) — report those to Yoto directly.
- Cloudflare Workers platform issues — report those to Cloudflare.
- Denial-of-service against the public demo instance, if one exists.

## What the security review covered (13 Sep 2026)

A dedicated pass over `apps/worker` before launch, focused on the code this project actually
wrote in the auth and media-fetch paths — the OAuth protocol itself is
`@cloudflare/workers-oauth-provider`'s job, not ours:

- **Two SSRF holes closed in `resolve.ts`** (the only place the Worker fetches a URL a *caller*
  supplies, via a tool's `audioUrl`/`imageUrl`): redirects were followed blind past the
  scheme/host allowlist, so a public https host under the caller's control could 302 to
  `http://` or to `169.254.169.254` — every redirect hop is now re-validated, capped at 5. And
  the IPv4-mapped-IPv6 filter matched the wrong string form and so never fired — IPv6 literals
  are now parsed into hextets and range-checked properly (loopback, link-local, NAT64, 6to4,
  IPv4-mapped/-compatible).
- **A client-registration TTL and a nightly purge cron were added** (the two MEDIUM findings
  from this review): dynamically-registered clients (DCR) now expire after 30 days instead of
  living forever, and a scheduled job sweeps orphaned/expired grants and tokens as
  defence-in-depth for KV's own TTL. Clients that connect via CIMD — what claude.ai actually
  uses — are never stored in KV at all, so this doesn't change anything for them.
- **Headers, CSP and logging were checked**: every page this Worker renders itself carries a
  strict `default-src 'none'` CSP (the one inline script on the landing page is allow-listed by
  its own SHA-256 hash, not by relaxing the policy), plus HSTS, `X-Frame-Options: DENY` and
  `X-Content-Type-Options: nosniff`. All logging goes through one function that refuses
  secret-shaped field names and scrubs secret-shaped values (JWTs, our own opaque tokens, long
  base64url runs) before a line is ever written.
- **Dependencies**: 0 vulnerabilities in production dependencies (`npm audit --omit=dev`). A
  single low-severity advisory remains against `esbuild`, pulled in only by `tsup`, a
  build-time-only dev dependency that never ships in the deployed Worker.
- **One low-severity issue was found and deliberately left open**: a narrow race in
  `refresh.ts` where two concurrent client token refreshes arriving at nearly the same moment
  can both read the still-valid upstream Yoto token and both trigger a rotating-refresh call —
  worst case is one extra re-auth prompt for the parent, never data loss, so it wasn't worth a
  lock for how rarely two refreshes truly overlap. See the comment in `refresh.ts`.

## How token storage is designed

Your Yoto tokens are stored encrypted, and the key is never written to our storage — it is
wrapped using your AI client's own token, of which we keep only a hash. A copy of our database
alone therefore decrypts nothing. Two honest caveats: the wrapping step uses a fixed constant
published in the open-source OAuth library we use (`@cloudflare/workers-oauth-provider`), not a
secret unique to this deployment, so anyone holding one of a parent's live client tokens could
decrypt the matching record; and because Dan operates this Worker, he could in principle change
its code to capture tokens as they pass through. The accurate claim is "nothing readable is
stored, and the server has no routine means to read it" — not "the operator is incapable of
reading it". The Yoto account id (`userId`) is stored in plain text as the grant's label.

Concretely: on the remote path, `@cloudflare/workers-oauth-provider` stores each authorization
grant's `props` (the Yoto access + refresh tokens) in Cloudflare KV under the scheme above.
Grants carry a TTL equal to the Yoto refresh-token lifetime and expire on their own (backed up
by the nightly purge cron described above); deleting the KV namespace revokes every connected
client at once — see "Incident response" below. On the local (CLI) path, tokens are stored in
the OS keychain (or a `0600` file as a fallback, with a loud warning), never in a database or a
server Dan operates.

## Incident response

- **Suspected compromise of `STATE_SECRET`** (the secret that encrypts the short-lived,
  in-flight PKCE state blob during sign-in — see `state.ts`): rotate it with
  `wrangler secret put STATE_SECRET`. Every sign-in already in progress fails and the parent
  just starts again; no already-issued grant is touched.
- **Suspected compromise of the KV namespace, or "disconnect everyone right now"**: delete the
  `OAUTH_KV` namespace (or its contents) in the Cloudflare dashboard. Every connected client's
  grant disappears at once; the next request from any of them gets a clean re-auth prompt
  through Yoto's own login page — no 500s, no partial state.
