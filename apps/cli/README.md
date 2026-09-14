# mcp-yoto

MCP server for Yoto — connect your Yoto library (cards, tracks, pixel-art icons, family
players) to Claude, Cursor, VS Code, and other MCP clients that run tools locally.

This is the local, command-line connector. It runs on your own machine and signs in
directly with Yoto — nothing about your account passes through anyone else's server.
(A remote, paste-one-link connector for claude.ai / ChatGPT is on the way; see the
[project README](https://github.com/danpillay87/mcp-yoto#readme) for the full story and
current status.)

## Install

**Claude Code:**

```
claude mcp add yoto -- npx -y mcp-yoto
```

**Cursor:** click to install — this link is a base64-encoded copy of
`{"command":"npx","args":["-y","mcp-yoto"]}`:

[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_yoto-000000)](cursor://anysphere.cursor-deeplink/mcp/install?name=yoto&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1jcC15b3RvIl19)

**VS Code:**

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_yoto-0098FF)](vscode:mcp/install?%7B%22name%22%3A%22yoto%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mcp-yoto%22%5D%7D)

**Any other MCP client:** run `npx -y mcp-yoto` as a stdio server. There's nothing to
configure beyond that — no API key, no account, no config file to hand-edit.

## Sign in

After adding the server, sign in once from a terminal:

```
npx mcp-yoto login
```

This opens your browser to **Yoto's own sign-in page**. Approve it there, then close the
tab — you're done. Your AI client can now list your cards, add tracks, and so on by
calling the `yoto_*` tools.

Your Yoto credential is stored in your OS keychain (Windows Credential Manager, macOS
Keychain, or the Linux Secret Service) when one is available, or in a plain file
otherwise. Run `npx mcp-yoto status` any time to see which, and whether you're signed in.

To disconnect: `npx mcp-yoto logout`.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `YOTO_CLIENT_ID` | (the shared public dev-app id) | Use your own registered Yoto dev app instead. |
| `YOTO_REDIRECT_PORT` | `8791` | Loopback port used during sign-in. Must match the redirect URI registered at Yoto — only change this if you've registered your own app on a different port. |
| `YOTO_NO_BROWSER` | unset | Set to `1` to print the sign-in URL instead of opening a browser automatically (useful over SSH). |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. Everything goes to stderr — stdout is reserved for the MCP protocol itself. |
| `MCP_YOTO_ICON_BASE` | GitHub-hosted icon set | Serve tool icons from somewhere else. |

## Troubleshooting

**"Port 8791 is already in use."** Something else is already listening on the loopback
port sign-in needs. Close it, or set `YOTO_REDIRECT_PORT` to a free port — but only if
you've also registered a matching redirect URI on your own Yoto dev app; the shared
public client is fixed to 8791.

**"System keychain unavailable — falling back to a local file."** Your OS has no
usable keychain right now (common on a headless Linux box with no Secret Service
running). This isn't fatal: your credential is written to a plain file instead, scoped
to your user profile. `npx mcp-yoto status` always tells you which store is in use.

**"Your Yoto session has expired." / a tool asks you to `yoto_sign_in`.** Your stored
refresh token has been rejected by Yoto (it may have been revoked from your Yoto account
settings, or simply expired). Run `npx mcp-yoto login` again.

## What this connects to

15 tools, all `yoto_*` — cards, tracks, icons, and device status (the live player-status
check is registered but not switched on yet -- Yoto doesn't grant that permission to
outside apps yet). Never asks for `family:devices:control` or `family:devices:manage`,
so this stays eligible for Yoto's Verified listing. Full tool table, architecture, and
privacy details: [github.com/danpillay87/mcp-yoto](https://github.com/danpillay87/mcp-yoto#readme).

## License

MIT — see [LICENSE](LICENSE). Originally derived from
[bperkinspdx/yoto-mcp-server](https://github.com/bperkinspdx/yoto-mcp-server) (MIT).
