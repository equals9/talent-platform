# Calyflow agents: mechanisms, boundaries, and design implications

Checked **2026-10-12 02:13 UTC / October 11, 2026 Pacific**. This is public documentation research. No account was created, connector authorized, model invoked, message sent, code installed, or paid service used.

**Recommendation:** use Calyflow as a recruiting-workflow design reference. Its documentation gives a concrete model for scoped specialists, role context, reviewed plans, tool permissions, run budgets, saved outputs, and human-controlled outreach. Do not treat it as a verified reusable code foundation: its official GitHub link currently returned 404, so the source, license artifact, and runtime controls could not be inspected.

## Access and what was actually observed

The user-supplied [Agents documentation](https://app.calyflow.ai/docs/agents) failed through the web-reading tool twice. A direct, unauthenticated HTTP read succeeded with **HTTP 200**, title **Agents · Calyflow docs**, and 45,333 decoded HTML characters in the initial read. It contained the public documentation, not a sign-in screen. The subagent's attempted hidden in-app browser navigation was unavailable because that browser surface was not available to the subagent. These are access-method limitations, not evidence that the docs require login.

Related sourcing, capabilities, security, responsible-AI, and self-hosting pages were readable with the web tool. FAQ, documents, and LinkedIn Proxy details were additionally read through public HTTP. The observations establish available documentation and stated product behavior. They do not establish an agent completing a task, a budget enforcement mechanism, approval denial, tenant isolation, credential handling, or output accuracy in a running account.

## Product mechanism

The agents page describes a specialist as instructions plus allowed tools and required documents. Runs assemble agency and client knowledge, project role documents, and live connector data, then save an editable result document. Built-in strategist, sourcing, and outreach agents power a project pipeline; library agents are imported as editable workspace copies. Missing required connectors block execution. Examples cover role analysis, screening, scorecards, sourcing, call preparation, and submission packs. [Agents](https://app.calyflow.ai/docs/agents).

The published library lists 24 agents. Its examples show source-specific search sequences saved as checklists before execution, reports grounded in candidate material, and outputs usable by later tasks. This is a workflow layer alongside recruiting systems, not simply an email finder. Library descriptions also include messages and scheduled Slack reporting, so connector side effects require their own review. [Automation library](https://www.calyflow.ai/automation-library).

## Execution, review, provenance, and cost boundaries

| Boundary | Documented behavior | What remains unverified |
| --- | --- | --- |
| Plan and qualification | Role documents generate a sourcing plan and criteria. A recruiter approves the proposed session. | Whether altered criteria invalidate prior approvals; exact criteria/run version binding. |
| Run limits | Goal and AI-spend budget stop a session; project caps and connector-credit limits are described. Progress can be resumed using saved coverage. | Hard enforcement, in-flight overshoot, retries, billing reconciliation, cancellation, and paid-call denial paths. |
| Candidate review | Scores, sources and profile links are presented for recruiter fit review. | Correct ownership, evidence completeness and quantitative ranking validity. |
| External sending | Draft → edit/review → approval → explicit send of approved text from a selected mailbox. | Approval binding to recipient/body/mailbox, duplicate-send protection, suppression enforcement and revocation. |

These rows summarize the [sourcing pipeline documentation](https://app.calyflow.ai/docs/sourcing), not a runtime test. A model budget and a data-source credit cap are distinct expenses.

Responsible-AI docs describe evidence quotations, missing information marked “not evident,” step traces, editable outputs, fit review, and no automatic hiring rejection. They explicitly say scoring accuracy is not formally benchmarked. They also describe run histories and an append-only governance log retained without automatic deletion and with a six-month floor. Those are product assertions; this research did not verify retention/deletion reconciliation or security. The document's legal interpretations were not independently evaluated. [Responsible AI](https://app.calyflow.ai/docs/responsible-ai).

Project documents use one active version per slot, archiving replaced files. CVs are selected for individual screening runs rather than included in every task. Client files are documented as outside model inputs; knowledge-base text is the route for shared model context. Agent results become editable output documents. [Documents and project files](https://app.calyflow.ai/docs/documents). The [FAQ](https://app.calyflow.ai/docs/faq) expressly confirms that project files are included in AI runs. Self-hosting does not by itself establish that configured external model providers receive no candidate data.

## Tools, data policy, and integration scope

The capability directory documents built-in project-document access and public web reading, plus many ATS, CRM, spreadsheet, enrichment, email, meeting, and sourcing connectors. Several ATS pages describe read-only behavior; capabilities also include campaign writes, mailbox sending, and saving sourced candidates to Calyflow DB. Connector presence therefore does not imply uniform read-only access. No stable general external developer API contract was established from the inspected pages. [Capabilities](https://app.calyflow.ai/docs/capabilities).

Hosted LinkedIn Proxy uses an included workspace pool, with 1–2 credits per search or profile collection. Docs say exhausted credit falls through to other connected tools. The capability is hidden on self-hosted deployments unless provisioned. The inspected documentation does not establish its underlying acquisition authorization, identity precision, provenance completeness, or data freshness for a specific person. [LinkedIn Proxy connector](https://app.calyflow.ai/docs/connectors/linkedin-proxy).

For this platform, **public professional sources only remains the governing acquisition policy**. Calyflow's LinkedIn Proxy, paid contact enrichment, commit-email extraction, private ATS context, and automatic messages are not inherited permissions. An individually published contact observation must retain its source and unknown deliverability; model criteria or provider labels cannot turn it into a verified inbox.

## Security, self-hosting, and source availability

Security docs state server-side connector calls, credentials excluded from model prompts, encrypted credential storage using AES-256-GCM with a separate key, workspace isolation at application and database layers, scoped access, disconnect controls, HTTPS/security headers, Clerk authentication, and signed inbound integration verification. These are useful requirements to test independently, not verified guarantees from this read. Credential isolation also does not mean connector results are never sent to the selected model. [Security documentation](https://app.calyflow.ai/docs/security).

Self-hosting docs say OAuth integrations require the operator's own provider apps and callback/environment configuration; API-key integrations keep their user setup flow. The inspected guide mainly covers connector setup and does not establish a reproducible deployment command, a downloadable release, or a verified installation. [Self-hosting](https://app.calyflow.ai/docs/self-hosting).

The docs label the project **AGPL-3.0** and link [Calyflow/calyflow-app](https://github.com/Calyflow/calyflow-app). The repo URL, unauthenticated `https://api.github.com/repos/Calyflow/calyflow-app`, and its `/license` endpoint all returned **404** during this check. This could reflect a private, moved, unavailable, or removed repository; its reason is unknown. The actual source and license artifact were therefore **not verified**. Borrowing independently implemented workflow ideas is the present recommendation; copying or adopting a codebase needs a reachable pinned source, actual license, dependency review, and runtime qualification.

## Concrete patterns for the consolidated platform

The following are proposed implementations inferred from the documentation, not new capabilities demonstrated by this research:

1. **Scoped task manifests.** Define a role task's required inputs, allowed public-source tools, output contract, stop conditions, and review action. Show missing requirements before a run. Keep the normal finder deterministic; add model execution only when it is useful and authorized.
2. **Version-bound context and evidence.** Bind a run to role criteria and active source versions. Keep candidate evidence, recruiter notes, quoted statements, and derived explanations distinguishable. Select candidate-specific material explicitly; never pull another person's CV into a run merely because it is in the same project.
3. **Inspectable plan and execution receipt.** Show selected sources, attempts, errors, evidence added, limits reached, and work remaining. A planned graph describes intent; the executed trace establishes what happened. Retain empty and failed cases rather than letting a completed run look like a qualified shortlist.
4. **Human authority at the action boundary.** Preserve fit review, exclusion, export, and pipeline-state authority. A future send operation needs explicit authorization bound to exact recipient, text, and sender, and a durable receipt. A draft or “approved candidate” should not authorize a message by inference.
5. **Fail closed on access and spend.** Show an unavailable source or exhausted allowance directly. Keep paid providers and private datasets disabled under the current policy. If future adapters are authorized, require explicit provider budgets and test denials before calls.

Avoid promoting an uncalibrated 0–100 score to qualification, equating GitHub activity with job eligibility, treating public commits as outreach consent, describing all connectors as read-only, or presenting self-hosting as proof of zero model-data egress. These are concrete assumptions the proposed integration must keep testable.

## Current evidence state

- **OBSERVED:** public documentation was readable; linked source repository and license API returned 404.
- **SOURCE_BACKED:** the product mechanisms and controls are stated in the official pages above.
- **UNVERIFIED:** code availability/license artifact, working installation, actual security/approval/spend enforcement, model quality, candidate yield, and commercial superiority.
- **NEXT CHEAP CHECK:** independently implement one role-context → public evidence → reviewed shortlist/export workflow and test ambiguous identities, missing facts, stale evidence, exclusions, and denied providers before adding agent automation.
