# Progress

Plain-English status of the mcp-yoto rebuild, as of 13 Sep 2026 21:45. ✅ done · ⏳ in progress · 🔴 needs Dan.

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
- ⏳ **Getting listed on the official MCP Registry.** Waiting on an approval code from GitHub before this can go through.
- ⏳ **The last few admin bits.** A browser-automation pass is currently working through npm's "trusted publisher" setting, a proper preview image for the GitHub page, and Yoto's "Verified" application form — Dan just needs to press Submit on the Yoto form once it's filled in and ready.
- 🔴 **Dan: tidy up a wrongly-named setting in Cloudflare.** One of the secret values got saved under itself as the name, instead of a proper label — see "Needs Dan" below for the exact command. Separately, the Yoto client secret has deliberately *not* been changed — that was Dan's call, not something overlooked.
- 🔴 **Dan: follow up in Discord with the live connect link**, now that the website version is proven to work end to end.

## Needs Dan

- **Delete the mis-named Cloudflare secret.** From `apps/worker`, run:
  ```
  npx wrangler@4.131.1 secret delete <that name> --name mcp-yoto --force
  ```
  If you're not sure which one it is, check the list first: `npx wrangler@4.131.1 secret list --name mcp-yoto` (from `apps/worker`).
- **Follow up on Discord** with the live connect link now the site is proven end to end: https://mcp-yoto.danpillay87.workers.dev/mcp
