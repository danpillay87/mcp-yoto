# Progress

Plain-English status of the mcp-yoto rebuild, as of 14 Sep 2026 05:25 BST. ✅ done · ⏳ in progress · 🔴 needs Dan.

- ✅ **The project is public, documented, and branded.** It has its own page on GitHub, a proper explanation (README), and its own look and feel.
- ✅ **Asked Yoto's own developer team for help.** Posted in their Discord asking for a test device ahead of their next product launch.
- ✅ **Fully listed on Yoto's own dashboard.** Name, description, a link to the privacy explanation, and a proper logo are all in place now.
- ✅ **Everything it can do is built and tested.** All 14 things it can do — listing your cards, building a new card, adding a track, and so on — with 228 automatic checks that all pass before anything ships.
- ✅ **The website version is live, has been security-checked, and tidies itself up.** It's running at https://mcp-yoto.danpillay87.workers.dev, a dedicated security review has been done, and a small nightly job cleans up loose ends on its own.
- ✅ **Proved the whole parent journey actually works, start to finish.** Dan signed in for real through claude.ai's own sign-in page, and a separate testing tool confirmed all 14 things it can do and pulled back his real cards.
- ✅ **The command-line version is properly published and double-checked.** Version 0.1.0 is out for anyone to install, and it's been tested working from a completely clean computer.
- ✅ **Dan's own computer is fully switched over to the new version.** The old always-running background task that kept the previous version alive has been removed, and its old files have been safely set aside rather than deleted.
- ✅ **Updates now go live automatically.** Cloudflare is connected up, so a change pushed to GitHub ships itself.
- ✅ **The privacy wording is honest and accurate**, not just legally-safe boilerplate.
- ✅ **Listed on the official MCP Registry.** Registered as io.github.danpillay87/mcp-yoto v0.1.0 and active.
- ✅ **Yoto verification form submitted.** Sent 13 Sep with a 1600×900 brand banner.
- ✅ **The mis-named Cloudflare secret has been deleted.** Only STATE_SECRET and YOTO_CLIENT_SECRET remain.
- ✅ **Yoto Space profile exists.** Registered under the same email address.
- ✅ **GitHub social preview set.** The repo card displays properly.
- ✅ **npm trusted publisher configured.** GitHub Actions release.yml is authorized to publish tagged releases.
- 🔴 **Dan: Tick "Allow npm publish" in npm security.** Open https://www.npmjs.com/package/mcp-yoto → Access → Trusted Publisher and check the box so tagged releases publish automatically instead of staging. Needs a security key.
- 🔴 **Dan: Follow up on Discord with the live connect link.** Reply in the same thread with https://mcp-yoto.danpillay87.workers.dev/mcp.
- ⏳ **Optional: Rotate the Yoto client secret.** The value was briefly exposed 13 Sep. Dan declined for now, but dashboard.yoto.dev/settings has the option if needed later.
- ✅ **New: you can now ask what's playing on a player right now.** A 15th thing it can do checks one player live — which card is loaded (by name, not just an ID), battery level, volume, nightlight colour, and whether headphones are plugged in. Built and tested (236 automatic checks now pass). It needed a narrow, read-only Yoto permission this project didn't already have (still nothing that can control a player), so the existing sign-in won't cover it until you sign in again. Asking it to force a fresh check-in isn't possible — Yoto only allows that with a permission this project deliberately never asks for — so it always shows the player's last known status instead.

## Needs Dan

- **npm security approval.** Go to https://www.npmjs.com/package/mcp-yoto → Access → Trusted Publisher and tick the box so GitHub Actions can publish. You'll need a security key for this step.
- **Discord follow-up.** Reply in the same thread (mcp-yoto channel) with the live connect link: https://mcp-yoto.danpillay87.workers.dev/mcp.
- **(Optional) Rotate Yoto client secret** if you want to revoke the one that was exposed briefly on 13 Sep. Available at dashboard.yoto.dev/settings — your choice, no urgency.
- **Sign in again** (CLI: `npx mcp-yoto login`; remote: reconnect the connector) to pick up the new "see a player's status" permission the new tool above needs — until then it'll ask you to reconnect rather than show real data.
