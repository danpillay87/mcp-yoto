<p align="center">
  <img src="assets/brand/logo-256.png" width="128" alt="mcp-yoto logo" />
</p>

<h1 align="center">mcp-yoto</h1>

<p align="center">Works with Yoto — connect your Yoto library to Claude and ChatGPT.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mcp-yoto"><img src="https://img.shields.io/npm/v/mcp-yoto.svg" alt="npm version" /></a>
  <a href="https://github.com/danpillay87/mcp-yoto/actions/workflows/ci.yml"><img src="https://github.com/danpillay87/mcp-yoto/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/danpillay87/mcp-yoto"><img src="https://img.shields.io/badge/Works%20with-Yoto-FF7A45" alt="Works with Yoto" /></a>
</p>

## For parents

What you can do once it's connected:

- See every card in your Yoto library (your own MYO cards and your family library) from inside Claude or ChatGPT.
- Ask your AI assistant to build a new card — turn an audio file, a story, or a set of tracks into a card on your Yoto.
- Add tracks to a card you've already made, without opening the Yoto app.
- Search and set pixel-art icons for your cards and chapters.
- Check on your family's Yoto players — see what's connected, without being able to control them remotely.

### What you can say

Once it's connected, just ask in plain English:

- "Make a bedtime card from these three files and give each track a moon icon."
- "Show me every card in my Yoto library."
- "Add this new song to the 'Car Songs' card."
- "Find a pixel-art icon of a dinosaur for chapter two."
- "Which of my kids' Yoto players are online right now?"

### How sign-in works

You paste one link into your AI app. That takes you to **Yoto's own sign-in page** — you sign in there, not here. We never see your password. Your Yoto tokens are stored encrypted, and the key is never written to our storage — it's wrapped using your AI app's own token, of which we keep only a hash, so a copy of our database alone decrypts nothing. Two honest caveats: the wrapping method is a fixed constant from the open-source library we use, not a secret unique to this server, so a live client token could decrypt the matching record; and because we run the server, we could in principle change its code to capture tokens in transit. The accurate claim is "nothing readable is stored, and we have no routine means to read it" — not "we are incapable of reading it". You can revoke access at any time from your Yoto account settings, which disconnects this instantly. See [PRIVACY.md](PRIVACY.md) for the full, plain-English explanation.

> 🚧 **Rebuild in progress (Sept 2026).** The command-line version works today; the paste-one-link version for claude.ai / ChatGPT lands in ~2 weeks.

## For developers

### Connect

> 🚧 **Rebuild in progress (September 2026).** The `npx` route below works today. The paste-one-link route for claude.ai and ChatGPT goes live once the website address ships — expected September 2026.

**claude.ai** — [Add the Yoto connector](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Yoto&connectorUrl=https%3A%2F%2Fmcp-yoto.danpillay87.workers.dev%2Fmcp) (or Settings → Connectors → Add custom connector, prefilled).

**ChatGPT** — Settings → Connectors → Advanced → Developer mode → Add connector → paste `https://mcp-yoto.danpillay87.workers.dev/mcp`.

**Claude Code:**

```
claude mcp add --transport http yoto https://mcp-yoto.danpillay87.workers.dev/mcp
```

**Power users — run it locally today:**

```
npx -y mcp-yoto
```

- **Cursor:** [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=yoto&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1jcC15b3RvIl19)
- **VS Code:** [Install in VS Code](vscode:mcp/install?%7B%22name%22%3A%22yoto%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mcp-yoto%22%5D%7D)

### Tools

15 tools, all `yoto_*`, each shipped with a title, description, icon, and all four MCP annotation hints (read-only / destructive / idempotent / open-world):

| Tool | Purpose | Key inputs | Read-only |
|---|---|---|---|
| `yoto_status` | Auth state, scopes, token-store kind (CLI), API reachability | – | yes |
| `yoto_sign_in` | CLI: launch loopback PKCE. Remote: sign in via your client's connector settings | `openBrowser?` | no |
| `yoto_sign_out` | CLI: delete local token. Remote: how to disconnect + revoke at Yoto | `confirm` | destructive |
| `yoto_list_cards` | My MYO cards or family library | `source: myo\|family`, `limit?`, `cursor?` | yes |
| `yoto_get_card` | Full card with chapters/tracks | `cardId` | yes |
| `yoto_create_card` | New MYO card, optional tracks + icon | `title`, `tracks[]?`, `iconRef?` | no |
| `yoto_update_card` | Rename / reorder / set icons | `cardId`, `patch` | destructive, idempotent |
| `yoto_delete_card` | Delete a MYO card | `cardId`, `confirm` | destructive |
| `yoto_upload_audio` | Upload + transcode → `yoto:#sha` | CLI `audioFilePath` · Remote `audioUrl` (https, size-capped, streamed) | no |
| `yoto_add_track` | Upload and append to a card | `cardId`, `audioFilePath\|audioUrl`, `trackTitle?`, `iconRef?` | no |
| `yoto_search_icons` | Search the public 16×16 icon catalogue | `query?`, `tags?`, `limit?` | yes |
| `yoto_upload_icon` | Upload a custom 16×16 icon | `imagePath\|imageUrl`, `title`, `autoConvert?` | no |
| `yoto_list_devices` | Family players (view only) | – | yes |
| `yoto_get_device_config` | Device config incl. right-hand-button shortcuts; 403 → friendly `FORBIDDEN_SCOPE` | `deviceId` | yes |
| `yoto_player_status` | What's playing now: card, battery, volume, nightlight, headphones | `deviceId?`, `refresh?` | yes |

### Architecture

One Cloudflare Worker runs the official MCP TypeScript SDK v2 (stateless Streamable HTTP) behind Cloudflare's own `@cloudflare/workers-oauth-provider` — the reference implementation for remote-MCP auth, so this project writes only the small Yoto-specific upstream handler, not its own OAuth server. The same core (Yoto client + tool definitions) also powers `npx mcp-yoto`, a local stdio server for direct use from Claude Code, Cursor, or any stdio-based MCP client. Requested scopes are `profile offline_access user:content:view user:content:manage user:icons:manage family:library:view family:devices:view family:device-status:view` — deliberately **no** `family:devices:control` or `family:devices:manage`, which is what keeps this app eligible for Yoto's Verified listing.

### Roadmap

| When | What |
|---|---|
| Week of 14 Sep | Scaffold + this outreach post (you're reading it) |
| Week of 14 Sep | Yoto client + the 15 tools, tested against a mocked API |
| Week of 14 Sep | `npx mcp-yoto` — local sign-in working end to end |
| Week of 21 Sep | Remote connector: Cloudflare Worker + Yoto OAuth, live for claude.ai / ChatGPT |
| Week of 21 Sep | Security pass, real-client verification, Yoto Verified submission |

### Prior art

This isn't the first Yoto MCP server. [`bperkinspdx/yoto-mcp-server`](https://github.com/bperkinspdx/yoto-mcp-server) is the origin this project was forked from and is rebuilt on top of. [`tmcinerney/yoto-mcp`](https://www.npmjs.com/package/yoto-mcp) is another independent Yoto MCP server on npm, built separately.

### Privacy & Security

- [PRIVACY.md](PRIVACY.md) — what we can and can't see, in plain English.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability, and how token storage is designed.

### License

MIT — see [LICENSE](LICENSE). Portions originally derived from `bperkinspdx/yoto-mcp-server` (MIT).
