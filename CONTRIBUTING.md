# Contributing

Thanks for looking at `mcp-yoto`. This is a small, personal open-source project, not a company product — please be patient with response times.

## Setup

```
npm install
npm run check   # biome + tsc -b + vitest, must be green before you open a PR
```

Requires Node >=22 (see `.nvmrc`).

## Repo shape

- `packages/core` — runtime-agnostic Yoto client + the 14 `yoto_*` tool definitions. No `node:*` imports (it runs in both the Cloudflare Worker and the Node CLI) — this is lint-enforced, see `biome.json`.
- `apps/worker` — the remote MCP server (Cloudflare Worker, OAuth via `@cloudflare/workers-oauth-provider`).
- `apps/cli` — the `npx mcp-yoto` local stdio server, published to npm.

## Pull requests

- Keep changes scoped and include a test where it makes sense.
- Add a changeset for anything user-facing: `npm run changeset`.
- Never commit a real Yoto token, client secret, or `.dev.vars` file.
- If you touch `apps/worker/src/upstream.ts` or `apps/worker/src/refresh.ts` (the OAuth code path), say so explicitly in the PR description — that code gets an extra security-focused read.

## Releasing

Releases are npm-triggered by a git tag; nothing here should be run except by Dan, and never as part of a normal PR.

### 1. Cut the version + changelog

```
npm run changeset   # once per user-facing change (already covered by "Pull requests" above)
npm run version     # runs `changeset version` -- bumps apps/cli/package.json + writes apps/cli/CHANGELOG.md
git add -A && git commit -m "chore: version packages"
npm run release:tag # reads apps/cli's new version and runs `git tag v<version>`
git push && git push --tags
```

Pushing the tag fires `.github/workflows/release.yml`: checkout, install, `npm run check`, build (bundles `@mcp-yoto/core` into `apps/cli/dist/main.js` via tsup), publish `apps/cli` to npm, then cut a matching GitHub Release with a `npm pack` tarball and a CHANGELOG excerpt attached.

### 2. One-time npm Trusted Publishing setup (before the *first* tag push)

`release.yml` publishes with **no `NPM_TOKEN` secret** — it uses npm's Trusted Publishing (OIDC): npm checks the GitHub Actions run's identity against a trusted publisher configured on the package itself. That configuration can only be added *after* the package exists on the registry, so the very first release has to go out by hand:

1. From this machine, logged in as `danpillay87` (`npm whoami` to confirm): `cd apps/cli && npm publish --access public --provenance`.
2. On [npmjs.com](https://www.npmjs.com/package/mcp-yoto) → **Settings** → **Trusted Publisher** → add **GitHub Actions**, repo `danpillay87/mcp-yoto`, workflow file `release.yml`, environment left blank.
3. Every release after that goes out through the tag → Actions path above with no manual `npm publish` and no token. Until step 2 is done, `release.yml`'s publish step will fail with a 403/404 — that is expected, not a bug.

### 3. One-time Cloudflare deploy secrets (before the first push that touches `apps/worker/**` or `packages/core/**`)

`.github/workflows/deploy.yml` deploys the Worker on every push to `main` that touches `apps/worker/**` or `packages/core/**` (plus a manual trigger from the Actions tab). It needs two repo secrets:

1. Mint the token: Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token** → **Edit Cloudflare Workers** template → scope it to the `mcp-yoto` account.
2. Set it (paste the value when prompted — never in chat, never committed):
   ```
   gh secret set CLOUDFLARE_API_TOKEN --repo danpillay87/mcp-yoto
   ```
3. The account id isn't secret, so it can be set directly:
   ```
   gh secret set CLOUDFLARE_ACCOUNT_ID --repo danpillay87/mcp-yoto --body 828108c62630af3720b482e6c4012c56
   ```

See also `docs/ops/cloudflare-rate-limit.md` for the (dashboard-only, no API) WAF rate-limit rule on `/token`, `/register` and `/authorize`.

### 4. MCP Registry listing (`server.json`)

`server.json` at the repo root describes this server for the official MCP Registry (schema: `2025-07-09`). To publish/update the listing there (**do this manually, it is not part of any workflow**):

```
npm install -g @modelcontextprotocol/registry/mcp-publisher   # or the current install method on the registry docs
mcp-publisher login github
mcp-publisher publish
```

`mcp-publisher login github` proves ownership of the `io.github.danpillay87` namespace via a GitHub OAuth flow; `publish` reads `server.json` from the current directory and pushes it to the registry. Re-run `publish` after bumping `server.json`'s `version` to match a new release.

## Reporting a security issue

See `SECURITY.md` — please don't open a public issue for anything credential- or token-related.
