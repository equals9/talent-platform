# Source integrations

This platform owns saved recruiter selections and role workflow. External source
projects retain their original evidence, identity records and data until an
explicit qualified adapter or migration changes that responsibility.

Candidate Intelligence OS CSV imports preserve original IDs and metadata but
do not carry complete contact evidence. TalentOS workspace version 1 carries
only its declared role/candidate subset. Preview warnings identify these gaps.
VitalCV and other source projects are not included or relicensed in this bundle.

The personal development workspace and private inventory are intentionally not
distributed. The included integrations/source-projects.json starts empty. A
local override at integrations/source-projects.local.json takes precedence
and is ignored by Git.

Version 0.2 adds optional live read-only evidence adapters for Candidate
Intelligence, the declared TalentOS SQLite contract and VitalCV's fixed public
typed-claim API. Explicit selected snapshots preserve original IDs and source
uncertainty; exact canonical NPI is required for credential association. See
LIVE_SOURCES.md. These connections do not merge complete upstream stores or
relicense their code. Exclusions are sticky across connected workflows.
