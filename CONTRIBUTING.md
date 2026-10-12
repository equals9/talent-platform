# Contributing

Use Node.js 22.13 or newer. Clone, run `npm test`, then `npm start` and open http://127.0.0.1:4320. No package install, API account or paid service is needed for the initial local workflow.

Describe the user-visible behavior and test a relevant boundary. Preserve public-source lineage, unknown deliverability, explicit person-match review, global exclusions and original import IDs. Keep extraction and role-fit evidence separate. Use synthetic data and temporary storage for tests.

External connectors must declare the source owner, authentication boundary, cost/access requirements, supported operations, provenance retained and unavailable fields. Do not hide a failure behind a mock success or paid fallback. Open an issue or proposed interface before adding dependencies or changing the storage model.

Run `npm test` and `npm run check`. Inspect `git status` and stage explicit paths. Never stage `.env`, SQLite/PostgreSQL stores, resumes, exports, raw candidate evidence, or `research/upstream`. A local test pass is not production authentication, deployed behavior, assessment validity or competitive superiority.
