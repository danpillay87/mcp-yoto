# Cloudflare rate limiting for the OAuth endpoints

**This is a dashboard-only, manual step.** Rate limiting rules are a *zone*
feature -- they attach to a DNS zone Cloudflare fronts (a custom domain on
Cloudflare's DNS). `mcp-yoto.danpillay87.workers.dev` is a `workers.dev`
subdomain, which has no zone of its own, so there is no API (Terraform,
`wrangler`, the Rulesets API) that can create this rule against it. It has to
be done by hand in the dashboard, and it has to be redone (once) if/when the
Worker moves to a custom domain that does have a zone.

Free-tier Cloudflare accounts get a limited number of these rules; one is
enough here.

## Why these three paths

`/token`, `/register`, and `/authorize` are the only unauthenticated routes
`@cloudflare/workers-oauth-provider` exposes (dynamic client registration,
token exchange/refresh, and the authorization redirect). They are the
credential-stuffing / token-guessing / registration-spam surface for this
Worker -- everything else either requires a valid Bearer token already
(`/mcp`) or is static (`/`, `/icons/*`, `/healthz`).

## Steps (Cloudflare dashboard)

1. Log in at <https://dash.cloudflare.com> with the account that owns the
   `mcp-yoto` Worker (account id `828108c62630af3720b482e6c4012c56`).
2. Open the account, then the Worker's route in **Security -> WAF -> Rate
   limiting rules** (older dashboards: **Security -> WAF -> Rate Limiting
   Rules**, or under the zone's own Security tab if the Worker already sits
   behind a custom domain zone).
3. **Create rule**:
   - **Rule name**: `mcp-yoto oauth endpoints`
   - **If incoming requests match**: Custom filter expression --
     `(http.request.uri.path eq "/token") or (http.request.uri.path eq "/register") or (http.request.uri.path eq "/authorize")`
     (adjust the hostname field/filter if the rule is scoped at a zone that
     serves more than this one Worker)
   - **Characteristics**: rate limit by **IP address** (default)
   - **Period**: 10 seconds
   - **Requests threshold**: 60
   - **When rate exceeds threshold, then**: **Block**
   - **For**: 10 seconds
4. **Deploy**.
5. Sanity check: hammer `/authorize` more than 60 times in 10 seconds from
   one IP (e.g. a quick local loop against the live URL) and confirm the
   dashboard's rule shows matches and the client starts getting blocked
   responses; then confirm it clears again after the 10 second block window.

## If/when a custom domain is added

Adding a custom domain puts the Worker's route on a real zone, at which point
the same rule can additionally be managed via the Cloudflare API / Terraform
(Rulesets API, `http_ratelimit` phase) if that's ever useful for
infrastructure-as-code. Not needed for the `workers.dev` launch -- the
dashboard rule above is the whole requirement for now.
