# Privacy

`mcp-yoto` is an independent, open-source project. It is **not** an official Yoto product — it's built by a parent, for parents, to connect a Yoto library to an AI client like Claude or ChatGPT. "Works with Yoto", not "made by Yoto".

## The short version

We never see your Yoto password. Your Yoto tokens are stored encrypted with a key only your AI client holds — we cannot read them. They expire automatically, and you can revoke access at Yoto any time.

## How sign-in actually works

1. You paste the connect link into your AI client (claude.ai, ChatGPT, Cursor, etc.).
2. Your client redirects you to **Yoto's own login page** — `login.yotoplay.com`. You sign in there, on Yoto's site, with Yoto's own consent screen. `mcp-yoto` never sees your password, and never renders its own login page.
3. Yoto hands back a token. It is encrypted before it is stored, using a key derived from your AI client's own credentials — not anything `mcp-yoto` holds. In practice, this means the operator of this server cannot decrypt your Yoto token, even with full access to the server's storage.
4. Every time your AI client makes a request, the request itself supplies what's needed to decrypt your token for that one call, use it against the Yoto API, and then discard it. Nothing is held in memory longer than the request.
5. Your access naturally expires when Yoto's refresh token would expire, and you can revoke it immediately from your Yoto account settings at any time — that instantly disconnects `mcp-yoto`.

## What we don't do

- No analytics, no tracking, no third-party trackers.
- No logs that contain your token, your child's name beyond what you type into a tool call, or anything else Yoto-account-identifying. Logs are redacted before they're written (see `SECURITY.md`).
- No selling or sharing of data — there is no data to sell; we don't hold your Yoto library, we relay requests to Yoto's own API on your behalf.

## Data flow, in words

Your AI client (Claude, ChatGPT, Cursor, ...) → signs in via Yoto's login page → `mcp-yoto` (a small relay, either a Cloudflare Worker or a program running on your own machine) → the Yoto API → back to your AI client. `mcp-yoto` does not have its own database of your cards, tracks, or devices; every read goes to Yoto live.

## Local (CLI) mode

If you run `npx mcp-yoto` locally instead of using the remote connector, your Yoto token is stored in your operating system's own credential manager (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux) — nowhere near this project's servers, because in that mode there is no server at all.

## Questions

Yoto is an independent company and this is an independent, third-party, open-source project maintained by one person in his spare time — not a Yoto product and not officially affiliated with or endorsed by Yoto. For anything Yoto-account-specific, see [Yoto's own privacy policy](https://yotoplay.com/pages/privacy-policy). For anything about this project, open a GitHub issue (for anything sensitive, see `SECURITY.md` instead).
