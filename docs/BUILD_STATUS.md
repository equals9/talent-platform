# Build status — public email workflow, v0.3.0

Implemented: a local recruiter workspace with public contact research, review,
global exclusions, roles, explicit saved candidates, pipeline events, reviewed
exports and optional live read-only evidence adapters for Candidate Intelligence,
TalentOS and VitalCV. Original source projects retain their stores and identity.

Version 0.3 adds up to four explicitly selected public source pages within the
existing shared five-page/45-second website budget. Selected seeds run before
other links; each seed has its own origin and robots boundary. Source evidence
retains quote kind, normalized context, retrieval timestamp, content digest and
byte count. Reported publication dates remain separate from observation time.
Name proximity is a review hint; unrelated addresses are preserved separately.
No new observation is automatically approved or considered deliverable.

Verified locally on Node.js 26.9.0: **136 Node tests and 14 Python reader tests
passed**, zero failures/skips. JavaScript syntax and diff checks passed. The
reader tests used the existing source Python environment with SQLAlchemy; they
need no production database. Hosted CI is configured for Node 24/26 and Python
3.12; consult Actions for the exact published revision.

A real recruiting workflow was tested in a separate local store. Five prospects
were selected from an official internal-medicine directory before email
availability inspection, for a publicly posted physician role. Primary-only
baseline runs produced the same 13 unrelated address observations per prospect,
including a form placeholder, and zero prospect-specific evidence. Revised runs
with manually nominated public sources produced named address observations for
**2 of the same 5 prospects**. One supplementary page timed out, one publisher
could not establish robots rules, and one prospect had no address in checked
sources. These failures and the original runs were retained. The comparison
includes a changed source plan; it is development evidence, not held-out recall.

Browser verification covered source-plan reuse, Website-only supplemental input,
form submission and cached replay, named evidence with hashes and unknown
reachability, separate unrelated-address history, explicit Keep to the role,
persistence after reload and downloaded pipeline CSV. Five researched prospects
and their research source links remained present; all unapproved email columns
were empty. No real-person association was approved or outreach sent.

Regression controls include invalid whole-plan validation before acquisition,
shared page/time budgets, independent origin/robots boundaries, SSRF and redirect
denials, changed-plan cache isolation, visible/mailto multi-person association
boundaries, hidden-payload/no-guessing behavior, malformed date handling, retained
unknown/pending states, source exclusions before linked/redirected requests,
late exclusions after Keep, historical records without supplemental fields,
role-stage/export denials, sticky email exclusions and unavailable-feed refusal.
An independent reviewer reproduced a mailto-only cross-person false association;
the corrected extractor passed the regression.

Normal platform table counts and digests matched their pre-pilot baseline; the
TalentOS database byte hash was unchanged. Candidate Intelligence stayed clean,
and the existing dirty TalentOS/VitalCV branches were retained without edits.
Configured evidence readers remained available. Private pilot records, personal
config, source inventories, credentials and upstream code are excluded from the
public source bundle.

Manual source nomination, unavailable/non-email pages, format coverage and live
network failures remain practical constraints. Candidate qualification,
recruiting interest and all email deliverability are unknown. The app remains a
trusted single-user loopback workspace; neither competitor superiority nor
production team readiness nor hiring outcomes have been demonstrated.
