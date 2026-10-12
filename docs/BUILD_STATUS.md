# Build status — live evidence milestone, v0.2.0

Implemented: a local recruiter workspace with public-source contact research,
review, global exclusions, roles, explicit saved candidates, pipeline events,
reviewed exports and import adapters. Live adapters now connect selected
Candidate Intelligence professional evidence, existing TalentOS role briefs and
public-reference candidates, and fixed VitalCV public typed-claim reads.

Verified locally on Node.js 26.9.0: **99 Node tests and 14 Python reader tests
passed**, with zero failures/skips. JavaScript syntax and diff checks passed.
The source-bridge Python tests used the existing source environment; they need
SQLAlchemy 2.0.54 but no production database. Hosted CI is configured for
Node 24/26 and Python 3.12; consult Actions for the exact published commit.

Rendered verification used a separate local database with actual authorized
source reads:

- Inspected an existing TalentOS brief before explicit import.
- Searched by public specialty/location keywords, inspected original assertions,
  and explicitly kept one real professional to the role at `researched`.
- Read VitalCV by the exact canonical NPI. The missing record was retained as
  `no_record`, with unknown qualification and no independent acceptance.
- Reloaded and inspected immutable source snapshots, original IDs, observation
  times and digests. A downloaded pipeline CSV retained source/snapshot lineage
  and omitted all unapproved email contacts.
- Inspected a separate live professional profile with 57 original webpage
  passages; reading it kept nobody in the normal user workspace.
- Checked the rendered user workspace's three live source statuses; browser
  error/warning logs were empty at final inspection.

Data preservation was checked separately: original platform table contents
matched their baseline; five original Candidate Intelligence recruiting tables
retained identical counts/digests; the TalentOS database byte hash was unchanged.
The Candidate Intelligence connection rejected a write with SQLSTATE 25006.
Original source branches, stores, historical observations and recruiter notes
were retained. Private evidence/configuration and upstream source code are
excluded from public publication.

Regression controls cover missing authorization, read-only bridge identity,
bounded/invalid reads, exact-NPI binding, invalid-role rollback, explicit Keep,
no name merge, immutable history, pending/unknown contact state, source email and
profile exclusions, an older source-page approval/export bypass, and actions
blocked when the configured exclusion feed is unavailable.

The workflow revealed and fixed literal-phrase-only discovery: combined title
and city keywords now require every literal term in both the indexed prefilter
and reconstructed current public fields. Coverage remains bounded and exposed.
Public registry records frequently lack contact/current-employer evidence;
missing provider records and upstream unknown/simulated/stale credential claims
remain gaps, not qualification.

No real-person email association was approved, outreach sent, eligibility decided,
hiring outcome observed or competitor comparison executed. A working adapter
does not prove complete data coverage, issuer verification or production team
readiness. The app remains a trusted single-user loopback workspace.
