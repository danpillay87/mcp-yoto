# Progress

Plain-English status of the mcp-yoto rebuild. ✅ done · ⏳ in progress · ⬜ not started · 🔴 blocked

- ⏳ **Phase 0 -- Scaffold.** Setting up the empty project (folders, settings, a testing robot that checks nothing is broken). What this means: nothing works yet, but the building site is laid out.
- ⬜ **Phase 0.5 -- Tell people about it.** Put the project on GitHub with a plain-English explanation, and post in Yoto's own developer chat asking for a test device. What this means: getting the word out early, before the code is finished, so a device request isn't stuck behind weeks of building.
- ⬜ **Phase 1 -- The Yoto talker.** Build the part that actually knows how to ask Yoto for your cards, tracks and icons. What this means: no sign-in yet, but the "vocabulary" for talking to Yoto is being written and tested.
- ⬜ **Phase 2 -- Sign in from your own computer.** The command-line version people can run today (`npx mcp-yoto`) with a working sign-in that stores your details safely on your own machine. What this means: this is the version a developer on Yoto's Discord could try first.
- ⬜ **Phase 3 -- Sign-in for the paste-one-link version.** The part of the online version that sends you to Yoto's own sign-in page and safely remembers that you signed in. What this means: this is the trickiest, most safety-critical part, and it gets tested hardest.
- ⬜ **Phase 4 -- The online version itself.** The part that actually lets Claude or ChatGPT list your cards, add tracks, and so on, once you've signed in online. What this means: this is when "paste one link" starts actually working end to end.
- ⬜ **Phase 5 -- Safety check.** A dedicated pass specifically looking for security holes in the sign-in code, the one part of this project where a mistake would matter most.
- ⬜ **Phase 6 -- Go live.** Turn on the real website address, publish the command-line tool properly, and set up so future updates ship safely and automatically.
- ⬜ **Phase 7 -- Prove it works for real.** Actually connect from a real Claude account, a real ChatGPT account, and other tools, and write the final instructions.

## Needs Dan

- Post the Discord message (draft is with the orchestrator, not repeated here).
- Pick the subdomain the online version will live at (e.g. `mcp-yoto.<something>.workers.dev`, or a custom domain).
- Set up a Cloudflare account on the Workers Paid plan ($5/mo) -- needed before the online version can go live.
- Register a second Yoto developer app (the first one is already used by the current command-line tool).
- Decide which ChatGPT plan to test on -- some of the write actions (like creating a card) may be restricted on the cheaper plans.
