# Live evidence adapters

Talent Platform owns explicit recruiter selections, roles and pipeline events.
Candidate Intelligence owns its original identity/evidence graph; TalentOS owns
its existing role/candidate store; VitalCV owns its credential claim service.
These adapters read selected professional records without migrating those stores.
The platform is a local single-user application, not a production team service.

## Configure optional readers

Create ignored `integrations/live-sources.local.json` from the example beside it.
Configure only readers you own or are authorized to read. Use absolute operator
paths; HTTP requests cannot choose database paths, tokens or service origins.
Omitting a reader leaves it unconfigured. The public source bundle contains no
working personal paths, credentials, candidate data or upstream source code.

Candidate Intelligence uses a separate loopback Python bridge. Set
`CANDIDATE_OS_SOURCE_PATH` to an existing compatible checkout and
`TALENT_EVIDENCE_TOKEN_FILE` to a private token file containing 64 random hex
characters, mode 0600. Configure that same token file in the Node gateway.
Run `scripts/start-evidence-reader.sh` with the existing source venv, or an
explicit `CANDIDATE_OS_READER_PYTHON`. The source environment supplies its own
SQLAlchemy schema and PostgreSQL driver. The bridge reads the existing local
database URL without executing environment-file text. It verifies every
transaction is read-only, rolls back, and rejects mutations and browser calls.
It does not start the original app, workers, scheduler, migrations or models.

TalentOS opens an existing compatible SQLite file read-only, checks its schema,
and enables `query_only`. A missing file or unsupported exclusion schema fails
without creating or migrating a database. The qualified contract uses
`search_projects`, `candidates`, `candidate_sources`, `candidate_source_evidence`
and `profile_suppressions`, with optional role-brief/intelligence tables.

VitalCV's optional reader uses only fixed public GET routes at
`https://api.vitalcv.com`. DNS/IP checks, pinned connections, bounded JSON and
blocked redirects prevent turning it into an arbitrary proxy. It sends no API
key or cookie. Passport, ingestion and receipt-creation routes are excluded.
Reads expose upstream claims and gaps; they do not independently validate them.

## Recruiter workflow

1. Open Projects & imports, refresh connections and browse TalentOS roles.
2. Inspect the original brief/criteria before importing a selected role. Original
   record IDs and immutable snapshots remain available. Criteria stay upstream
   interpretations; they do not establish agreement, an active vacancy or fit.
3. Search Candidate Intelligence using literal AND keywords, such as
   `Sacramento Internal Medicine`, or browse public-reference TalentOS records.
   Results expose bounded/incomplete coverage. Search and inspection keep nobody.
4. Inspect source evidence, then explicitly Keep a person to a role or library.
   No names merge. Keeping creates a local researched-stage record and immutable
   selected snapshots; it does not inherit upstream hiring stages.
5. Inspect saved evidence from Candidates. An exact canonical NPI from Candidate
   Intelligence enables an explicit VitalCV read. No name-based credential join
   is performed. Missing records, source errors, unknown licenses, simulated
   claims, expiry, retractions and review requirements stay distinguishable.
6. Export a role pipeline. Source URLs, original person IDs, snapshot IDs and
   unknown qualification accompany the handoff. Contacts require separate source
   evidence and recruiter association review before contact export.

Public website passages keep their original quotes. Structured registry facts
and normalized credential objects are labeled as structured assertions/claims,
not verbatim quotes. Exact original observation times, source IDs and content
hashes are retained when supplied. Fresh reads do not make older observations
fresh. Registry identity is not current employment or board verification.

## Exclusions and evidence integrity

TalentOS URL/email exclusions are copied into sticky platform exclusions and
applied to source searches, Keep, role attachment, review and exports, including
old contact searches. A failed configured exclusion feed blocks actions instead
of being treated as an empty feed. Removing an upstream exclusion does not
automatically remove the platform exclusion. URL normalization is for exclusion
matching only; it never merges people by name or profile similarity.

Only quoted, supported observed professional emails can enter pending local
research jobs. Inferred/private/registry-contact observations are withheld.
Deliverability remains unknown; no mailbox probe or automatic contact approval
occurs. Evidence snapshots reject updates/deletes. Refresh adds an observation
without rewriting earlier evidence or recruiter notes. The adapters expose
selected records rather than dumping entire source stores.

## Verification

`npm test` exercises the contact engine, import contracts and live gateway/Keep
workflow using temporary databases. `npm run check` checks JavaScript syntax.
Python bridge tests need only `test/requirements-reader.txt` and can run with
`npm run test:reader`; they use synthetic read-only/HTTP fixtures, not production
rows. Hosted CI runs Node 24/26 and Python 3.12. Live source and rendered-browser
checks are separate from these deterministic checks and require configured
operator sources. See BUILD_STATUS.md for the last scoped verification.
