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

## Reporting a security issue

See `SECURITY.md` — please don't open a public issue for anything credential- or token-related.
