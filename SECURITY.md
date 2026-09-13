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

## How token storage is designed

This server is built so that its operator cannot read a signed-in parent's Yoto token. On the remote path, `@cloudflare/workers-oauth-provider` stores each authorization grant's `props` (the Yoto access + refresh tokens) in Cloudflare KV encrypted with a key wrapped using the connecting AI client's own token as key material — that key never touches KV, so full read access to the KV namespace does not decrypt a single Yoto token. Grants carry a TTL equal to the Yoto refresh-token lifetime and expire on their own; deleting the KV namespace revokes every connected client at once. On the local (CLI) path, tokens are stored in the OS keychain (or a `0600` file as a fallback, with a loud warning), never in a database or a server Dan operates.
