# Progress

Plain-English status of the mcp-yoto rebuild. ✅ done · ⏳ in progress · 🔴 needs Dan.

- ✅ **The project is public and set up properly.** It has its own page on GitHub with tests that run automatically on every change.
- ✅ **Posted about it publicly.** Told the people who make Yoto's own developer tools about the project, asking for a test device ahead of their next product launch.
- ✅ **Listed on Yoto's own dashboard.** It has a description and a link to the privacy explanation there. Still needs a proper logo image adding to that listing.
- ✅ **All 14 things it can do are built and tested.** Listing your cards, building a new card, adding a track, setting a pixel-art icon, checking your players — 227 separate automatic checks run against all of it before anything ships.
- ✅ **Signing in works for the website version.** A parent can sign in through Yoto's own login page and the site remembers them safely.
- ✅ **The website version is live** at https://mcp-yoto.danpillay87.workers.dev.
- ✅ **The command-line version works.** It's signed in on Dan's own computer right now and lists his real cards.
- ✅ **A dedicated security check has been done**, and it found two gaps that were fixed before anyone outside used this — see below for what that means in practice.
- ✅ **The plumbing for shipping updates automatically is built** (tests, checks, and a release process), ready for when it's turned on.
- ✅ **Dan's own computer has been switched over to the new version.** The old always-running background task that used to keep the previous version alive has been removed, and its old files have been safely set aside (not deleted).
- ⏳ **A simpler, cleaner logo.** The current one needs redoing as one plain shape rather than something more fiddly.
- 🔴 **Publishing the command-line version properly, for anyone to install.** Dan needs to turn on an extra security step (two-factor login) on the npm publishing website, then run one command to make it official.
- 🔴 **A real test from Dan's own everyday Claude account** — connecting the website version the exact way a parent would, start to finish. This is the check that actually matters most.
- 🔴 **Applying to Yoto for their "Verified" badge.** This can only happen once the command-line version is properly published (the step above).
- ⏳ **Putting the security fixes and the new logo live on the website version.** Small, low-risk, just needs doing.
- 🔴 **Adding a preview image for the GitHub page**, so it looks right when shared as a link. A short manual step in GitHub's settings.
- 🔴 **Turning on automatic deployment**, so future updates go live on their own instead of by hand. Needs Dan to hand Cloudflare a key.
- 🔴 **Turning on Dan's "trusted publisher" status with npm**, which is only possible after the first manual publish (see above).

## What the security check found and fixed

Two medium-priority gaps, both closed before this went in front of anyone outside:

1. A way someone could have redirected the audio/image upload feature to fetch from an address it shouldn't have been able to reach. Closed.
2. Registered connections that never expired. Now they automatically expire after 30 days, and a small nightly check tidies up anything left behind. This doesn't apply to how most parents will actually connect (claude.ai's own method isn't affected at all).

One small, low-risk timing quirk was found and left alone on purpose: if two sign-in refreshes happen at the exact same moment, the worst that can happen is a parent is asked to sign in again — nothing is lost, and fixing it wasn't worth the extra complexity.

## Needs Dan

- **Publish the command-line tool to npm.** First turn on two-factor login at https://www.npmjs.com/settings — then, from this project's folder, run: `npm publish --workspace apps/cli --access public --provenance`
- **Try connecting from your own everyday claude.ai account**, the way a parent actually would: paste `https://mcp-yoto.danpillay87.workers.dev/mcp` into Settings → Connectors → Add custom connector, sign in through Yoto's page, and ask it to list your cards.
- **Submit the Yoto Verified application** once the npm publish above is done: https://yoto.dev/verify
- **Upload a GitHub social preview image** at https://github.com/danpillay87/mcp-yoto/settings (scroll to "Social preview").
- **Give Cloudflare a deploy key** so updates can ship automatically: `gh secret set CLOUDFLARE_API_TOKEN --repo danpillay87/mcp-yoto`
- **Turn on npm's "trusted publisher" setting** for this package — only possible after the first manual publish above; the option then appears on the package's npm settings page.
