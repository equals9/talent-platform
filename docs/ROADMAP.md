# Platform roadmap: useful workflows with evidence

Owner direction, October 11, 2026: one open-source platform serving solo recruiters/agencies first, then in-house talent teams, then candidate/clinician and healthcare-employer experiences. Competitive leadership is the target, not an established result. The central workspace integrates existing source owners rather than replacing their historical evidence or copying every stack.

## Milestone 1: working recruiter desk

Current implementation: requisition → named public-source research → page/contact evidence → explicit Keep → human association review/exclusion → saved role pipeline → reviewed export. Import previews retain original project/record IDs and warn about missing evidence. Catalog and development workspace unify project ownership. See Build Status for actual verification.

Acceptance: the rendered flow persists after reload; unknown deliverability remains unknown; discovery does not keep or approve people; global suppression survives import/retry/export; invalid imports leave no partial state; original source data remains intact.

## Milestone 2: candidate evidence and criteria

Highest-priority next implementation: a selected-person Candidate Intelligence read adapter, qualified against its current local graph/API without acquisition workers, migrations or model calls. Use original evidence IDs, URL, hash, retrieved time and verbatim claim support. Obtain service-only startup evidence before declaring the source connected. Then incorporate TalentOS's existing criteria/calibration contracts through a licensed/owned integration boundary.

Acceptance: supported, contradicted and unknown hard criteria remain distinct; names never merge; a contact does not increase role fit; imported scores remain labeled upstream; a retracted claim cannot become current qualification; search does not silently create pipeline membership. Test fresh cases with ambiguous identities, missing evidence, stale assertions and inaccessible sources.

Calyflow's scoped specialists and versioned documents provide a useful mechanism reference for a later task layer: required role/candidate inputs, allowed tools, output schema, source/access budget, stop conditions and explicit review action. Bind actual runs to those inputs and distinguish proposed plan from executed evidence. The current finder remains deterministic; adding an agent definition alone does not create or qualify model execution. See `research/CALYFLOW_AGENTS.md`.

## Milestone 3: clinician/credential handoff

Connect a scoped VitalCV evidence reader through existing issuer/authority contracts. Public-source research must never create a verified credential receipt. Keep primary-source observation, candidate identity association, freshness/revocation, scoped validation, employer judgment and actual successful start distinct.

Acceptance: similar-name/contradictory IDs, inactive/expired credentials and unknown statuses cannot produce an unqualified positive; source receipt limitations and actual persistence are visible. This is a candidate/employer workflow extension, not biometrics, cognitive-load or personality scoring.

## Milestone 4: teams and owned workflow

Introduce production authentication, tenant/object authorization, recruiter/hiring-manager roles, candidate access and correction, versioned role criteria, secure document intake, retention controls, integration credential handling and audit. Preserve the local/self-host option. Measure collaboration benefit before adding infrastructure. Solo desk data is not automatically a team tenant.

Acceptance: deny paths across tenants, correction/retraction behavior, allowed export boundaries, retention/recovery, safe attachments, access revocation and concurrency. Qualify backups/migrations before public hosting.

## Milestone 5: authorized execution and integrations

Add selected ATS/calendar interfaces, recruiter-reviewed outreach drafts, explicit sending authority, interview transcript intake and structured review only when they advance a real workflow. Compare mature Odoo/Frappe ATS states and Twenty API extension effort before implementing a second system of record. No generic agent framework, vector store, model download or paid provider is a default requirement.

Acceptance: idempotent external side effects, correct recipients, opt-outs/suppression, actual provider receipts, rate/cost limits and fail-closed permissions. Interview records require authorized/consented input; evaluated summaries cite evidence and never invent a hiring decision.

## Competitive evaluation

Hypothesis: a traceable, current, recruiter-reviewed shortlist reduces unsupported qualification claims and manual review effort for a specific role. Start with one fresh role and 10–20 candidates under the same allowed sources and time budget as a manual baseline. Include negative cases. Measure evidence-supported hard-criterion precision, unknowns, identity errors, freshness, reviewed-contact availability, excluded addresses and recruiter minutes separately.

Metaview/hireEZ/Noon/Juicebox already advertise broad AI workflows, calibration and human controls. Juicebox documents healthcare license filters. Feature breadth, healthcare alone and an evidence schema do not establish differentiation. Compare authorized competitor outputs only after the manual baseline and new workflow are repeatable. Time-to-fill and hiring conversion require real outcome observation.
