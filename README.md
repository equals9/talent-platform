# Talent Platform

MIT open-source recruiting workspace for solo recruiters and agencies, with a
path toward in-house teams and healthcare hiring. This is a local single-user
milestone: public contact research, source review, roles, explicit saved
candidates, pipeline history, reviewed export, and source import adapters.

Requires Node.js 22.13 or newer. No npm dependencies or provider key.

```sh
npm test
npm start
```

Open http://127.0.0.1:4320. Keep the server running. Create a role, research a
name with a known professional website domain, review the source evidence,
explicitly keep a prospect, and export the role pipeline. Contact approval
and keeping a person are separate; deliverability stays unknown. Exclusions
apply globally to future discoveries and exports. `/contacts` provides the
original contact review workspace.

Imports support Candidate Intelligence OS CSV projections and TalentOS
workspace version 1. Preview shows omitted fields before explicit commit.
Imported email labels cannot become approved contacts without separate source
evidence and review. No names are automatically merged.

This source bundle has an empty source-project catalog and no personal
records, credentials, source-repository paths, raw audit downloads or private
inventories. Add your own source entries using the catalog schema if needed.
`npm run doctor` inspects registered source folders and fixed local service
reachability without starting services or reading candidate payloads.

The local server uses loopback/host/origin/token controls for one trusted user;
production authentication, tenant isolation and team workflows remain future
work. LinkedIn links are references only; no paid contact fallback, mailbox
probe, external sending or automatic hiring decision is enabled.

See docs/ROADMAP.md and research/ for the broader platform direction, PRISM
audit, eight OSS alternatives, current competitors and Calyflow agent patterns.
Local tests establish scoped behavior, not comparative recruiting superiority.
THIRD_PARTY.md records upstream licensing boundaries.
