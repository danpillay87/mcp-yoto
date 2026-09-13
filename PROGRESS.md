# Progress

Plain-English status of the mcp-yoto rebuild. ✅ done · ⏳ in progress · ⬜ not started · 🔴 blocked

- ✅ **Phase 0 -- Scaffold.** The project's building site is laid out: folders, settings, and a testing robot that checks nothing is broken (it runs automatically on every change from now on). What this means: nothing user-facing works yet, but the foundation is solid and every future change gets checked automatically.
- ✅ **Phase 0.5 -- Tell people about it.** The project is public on GitHub with a plain-English explanation (parents first, developers second), and the automatic checker is green on the very first commit. What this means: anyone can see the project and its honest "rebuild in progress" status today. Still needs Dan to actually post in Yoto's developer chat -- see "Needs Dan" below.
- ⬜ **Phase 1 -- The Yoto talker.** Build the part that actually knows how to ask Yoto for your cards, tracks and icons. What this means: no sign-in yet, but the "vocabulary" for talking to Yoto is being written and tested.
- ⬜ **Phase 2 -- Sign in from your own computer.** The command-line version people can run (`npx mcp-yoto`) with a working sign-in that stores your details safely on your own machine. What this means: this is the version a developer on Yoto's Discord could try first.
- ⬜ **Phase 3 -- Sign-in for the paste-one-link version.** The part of the online version that sends you to Yoto's own sign-in page and safely remembers that you signed in. What this means: this is the trickiest, most safety-critical part, and it gets tested hardest.
- ⬜ **Phase 4 -- The online version itself.** The part that actually lets Claude or ChatGPT list your cards, add tracks, and so on, once you've signed in online. What this means: this is when "paste one link" starts actually working end to end.
- ⬜ **Phase 5 -- Safety check.** A dedicated pass specifically looking for security holes in the sign-in code, the one part of this project where a mistake would matter most.
- ⬜ **Phase 6 -- Go live.** Turn on the real website address, publish the command-line tool properly, and set up so future updates ship safely and automatically.
- ⬜ **Phase 7 -- Prove it works for real.** Actually connect from a real Claude account, a real ChatGPT account, and other tools, and write the final instructions.

## What's live right now

- Repo: [github.com/danpillay87/mcp-yoto](https://github.com/danpillay87/mcp-yoto) -- public.
- The automatic checker (formatting, type-safety, tests) is green: [latest run](https://github.com/danpillay87/mcp-yoto/actions).
- Private security reporting is switched on, so a security issue can be reported without it being visible to the public first.
- The command-line tool and the online version are both still stubs today -- see the README's status note.

## Needs Dan

- Post the Discord message (draft is with the orchestrator, not repeated here).
- Pick the subdomain the online version will live at (e.g. `mcp-yoto.<something>.workers.dev`, or a custom domain).
- Set up a Cloudflare account on the Workers Paid plan ($5/mo) -- needed before the online version can go live.
- Register a second Yoto developer app (the first one is already used by the current command-line tool).
- Decide which ChatGPT plan to test on -- some of the write actions (like creating a card) may be restricted on the cheaper plans.
