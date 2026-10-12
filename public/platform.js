'use strict';

const $ = selector => document.querySelector(selector);
const state = { token: null, workspace: { roles: [], candidates: [], memberships: [], events: [], imports: [], stages: [] }, jobs: [], projects: [], integrations: [], selectedJob: null, selectedRole: null, submitting: false, polling: false, importPreview: null, view: 'research', liveSources: [], sourceResults: null, sourceDetail: null, sourceRequest: 0 };
let toastTimer;
const stages = ['researched', 'shortlisted', 'contacted', 'interviewing', 'offer', 'hired', 'closed'];
const stageLabel = value => String(value || '').replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function action(label, className, callback) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', callback);
  return node;
}
function date(value) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
function safeLink(value, label, className = '') {
  let url;
  try { url = new URL(value); } catch { return el('span', className, label || value || 'Source not provided'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return el('span', className, label || 'Source not available');
  const node = el('a', className, label || url.hostname + (url.pathname === '/' ? '' : url.pathname));
  node.href = url.href;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
}
function error(selector, message) {
  const node = $(selector);
  node.textContent = message || '';
  node.hidden = !message;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
async function api(path, options = {}) {
  if (!state.token) throw new Error('The local server is disconnected. Reload after starting the workspace.');
  const response = await fetch(path, { ...options, headers: { 'X-Local-Token': state.token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, cache: 'no-store' });
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch { /* Non-JSON transport error. */ }
    throw new Error(body?.error || `Request failed (${response.status}). Please try again.`);
  }
  return response;
}
const json = async (path, options) => (await api(path, options)).json();
const post = (path, body) => json(path, { method: 'POST', body: JSON.stringify(body) });
function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase(); }
function counted(count, singular, plural = `${singular}s`) { return `${count} ${count === 1 ? singular : plural}`; }
function jobName(job) { return job.input?.name || job.input?.company || job.input?.domain || 'Contact research'; }
function statusLabel(status) { return ({ complete: 'Research complete', no_result: 'No email found', running: 'Searching', error: 'Needs attention', interrupted: 'Interrupted', approved: 'Confirmed match', pending: 'Needs review', suppressed: 'Excluded' })[status] || stageLabel(status); }
function projectStatus(status) { return ({ cataloged_source_only: 'Source cataloged', workspace_subset_import_adapter: 'Subset import ready', projection_import_adapter: 'Projection import ready', source_snapshot_incorporated: 'Contact engine included', workflow_cataloged_no_runtime: 'Workflow cataloged', historical_empty_context: 'Historical context' })[status] || stageLabel(status); }
function pill(value, label) { return el('span', `status-pill ${value}`, label || statusLabel(value)); }
function upsertJob(job) {
  const index = state.jobs.findIndex(item => item.id === job.id);
  if (index < 0) state.jobs.unshift(job); else state.jobs[index] = job;
  state.jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
function showView(view) {
  if (!['research', 'candidates', 'roles', 'projects'].includes(view)) view = 'research';
  state.view = view;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${view}`;
  for (const node of document.querySelectorAll('[data-view]')) {
    node.classList.toggle('active', node.dataset.view === view);
    if (node.dataset.view === view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  }
  $('#page-name').textContent = { research: 'Research', candidates: 'Candidates', roles: 'Roles & pipeline', projects: 'Projects & imports' }[view];
  history.replaceState(null, '', `#${view}`);
}
function roleOptions(select, emptyLabel = 'Candidate library only', initialValue) {
  const previous = initialValue === undefined ? select.value : initialValue;
  select.replaceChildren(el('option', '', emptyLabel));
  select.firstChild.value = '';
  for (const role of state.workspace.roles) {
    const option = el('option', '', `${role.title}${role.company ? ` · ${role.company}` : ''}`);
    option.value = role.id; select.append(option);
  }
  if (state.workspace.roles.some(role => role.id === previous)) select.value = previous;
}
function renderMetrics() {
  const contacts = state.jobs.flatMap(job => job.results || []);
  $('#metric-candidates').textContent = state.workspace.candidates.length;
  $('#metric-roles').textContent = state.workspace.roles.filter(role => role.status === 'open').length;
  $('#metric-review').textContent = contacts.filter(contact => contact.review === 'pending').length;
  $('#metric-confirmed').textContent = new Set(contacts.filter(contact => contact.review === 'approved').map(contact => contact.email)).size;
  $('#nav-candidates').textContent = state.workspace.candidates.length;
  $('#nav-roles').textContent = state.workspace.roles.length;
  for (const id of ['research-role', 'candidate-role']) roleOptions($(`#${id}`));
}
function renderHistory() {
  const list = $('#research-history'); list.replaceChildren();
  $('#history-count').textContent = counted(state.jobs.length, 'search', 'searches');
  if (!state.jobs.length) { list.append(el('p', 'small-empty', 'Your searches will appear here.')); return; }
  for (const job of state.jobs.slice(0, 25)) {
    const row = action('', `history-item${state.selectedJob === job.id ? ' active' : ''}`, () => { state.selectedJob = job.id; renderHistory(); renderResearch(); });
    row.setAttribute('aria-pressed', String(state.selectedJob === job.id));
    row.append(el('span', 'avatar', initials(jobName(job))));
    const copy = el('span', 'history-copy');
    copy.append(el('span', 'history-title', jobName(job)), el('span', 'history-meta', `${job.mode === 'website' ? 'Website' : job.mode === 'paste' ? 'Pasted text' : 'Single page'} · ${job.status === 'running' || job.status === 'error' || job.status === 'interrupted' ? statusLabel(job.status) : counted(job.results?.length || 0, 'email')}`));
    row.append(copy, el('span', `status-dot ${job.status}`)); list.append(row);
  }
}
function coveragePanel(coverage) {
  const details = el('details', 'coverage');
  const pages = coverage.pages || [];
  const read = pages.filter(page => page.status === 'read').length;
  details.append(el('summary', '', `Pages checked · ${read} read of ${counted(pages.length, 'attempt')}`));
  for (const page of pages) {
    const row = el('div', 'coverage-row');
    const copy = ({ read: `${counted(page.emailCount || 0, 'published email')}`, duplicate: 'Already checked', blocked: 'Blocked by robots', error: 'Could not read' })[page.status] || stageLabel(page.status);
    row.append(safeLink(page.url), el('span', '', copy));
    if (page.error) row.title = page.error;
    details.append(row);
  }
  for (const warning of coverage.warnings || []) details.append(el('p', 'coverage-warning', warning));
  if (coverage.stopReason === 'max_pages') details.append(el('p', 'coverage-warning', 'Stopped at the page limit. This is a bounded search of relevant links.'));
  if (coverage.stopReason === 'time_limit') details.append(el('p', 'coverage-warning', 'Stopped at the time limit. Some pages were not checked.'));
  return details;
}
async function reviewContact(jobId, resultId, review, control) {
  control.disabled = true;
  try {
    const { job } = await post('/api/review', { jobId, resultId, review });
    upsertJob(job);
    await refreshWorkspace();
    renderAll();
    toast(review === 'approved' ? 'Person match confirmed. Deliverability remains unknown.' : review === 'suppressed' ? 'Email excluded across this workspace.' : 'Contact returned to review.');
  } catch (cause) { toast(cause.message); control.disabled = false; }
}
function contactCard(contact, jobId) {
  const card = el('article', 'contact-card');
  const top = el('div', 'contact-top');
  top.append(el('h3', 'email-heading', contact.email), pill(contact.review || 'pending')); card.append(top);
  card.append(el('p', 'contact-tagline', (contact.flags || []).includes('shared_mailbox') ? 'Published address · shared mailbox indicator' : 'Published address · source observation'));
  const facts = el('div', 'contact-facts');
  const person = el('div'); person.append(el('span', '', 'Person association'), el('strong', '', contact.review === 'approved' ? 'Recruiter confirmed' : contact.review === 'suppressed' ? 'Excluded from use' : 'Requires human review'));
  const delivery = el('div'); delivery.append(el('span', '', 'Email deliverability'), el('strong', '', stageLabel(contact.deliverability || 'unknown')));
  facts.append(person, delivery); card.append(facts);
  for (const source of contact.sources || []) {
    const sourceNode = el('div', 'source-entry');
    sourceNode.append(source.url ? safeLink(source.url) : el('span', '', source.type === 'pasted_text' ? 'Recruiter-pasted public text' : 'Source text'));
    if (source.observedAt) sourceNode.append(el('div', 'source-time', `Observed ${date(source.observedAt)}`));
    const context = source.context || source.quote || contact.context;
    if (context) sourceNode.append(el('blockquote', '', context));
    card.append(sourceNode);
  }
  if (!contact.sources?.length && contact.context) card.append(el('blockquote', 'source-entry', contact.context));
  const controls = el('div', 'contact-actions');
  if (contact.review === 'pending') {
    const approve = action('Confirm person match', 'button primary small', () => reviewContact(jobId, contact.id, 'approved', approve));
    controls.append(approve);
  } else if (contact.review === 'approved') {
    const pending = action('Return to review', 'button secondary small', () => reviewContact(jobId, contact.id, 'pending', pending)); controls.append(pending);
  }
  if (contact.review !== 'suppressed') {
    const exclude = action('Exclude email', 'button danger small', () => reviewContact(jobId, contact.id, 'suppressed', exclude)); controls.append(exclude);
  }
  if (controls.childNodes.length) card.append(controls);
  card.append(el('p', 'review-note', contact.review === 'suppressed' ? 'Excluded globally. This address is withheld from exports.' : 'Confirming records your assessment that this address belongs with this person. It does not verify deliverability.'));
  return card;
}
function stateMessage(title, message, loading = false, isError = false) {
  const node = el('div', `state-message${isError ? ' error' : ''}`);
  if (loading) node.append(el('div', 'spinner'));
  node.append(el('h3', '', title), el('p', '', message)); return node;
}
function keepPanel(job) {
  const box = el('div', 'keep-bar');
  const existing = state.workspace.candidates.find(candidate => candidate.sourceProject === 'lead-finder' && candidate.sourceId === job.id);
  box.append(el('p', '', existing ? 'This prospect is saved. You can also add them to a role. Contact review remains attached to the original research.' : 'Keep the person and their research in your library. Published email matches remain pending until you review them.'));
  const controls = el('div', 'keep-controls'); const roleSelect = el('select');
  roleSelect.setAttribute('aria-label', 'Role for this prospect'); roleOptions(roleSelect, 'Candidate library only', $('#research-role').value);
  const keep = action(existing ? 'Keep to role' : 'Keep prospect', 'button primary', async () => {
    keep.disabled = true;
    try {
      const result = await post('/api/keep-research', { jobId: job.id, ...(roleSelect.value ? { roleId: roleSelect.value } : {}) });
      await refreshWorkspace(); renderAll();
      toast(roleSelect.value ? 'Prospect kept in the selected role.' : result.reused ? 'Prospect is already in your library.' : 'Prospect kept in your candidate library.');
    } catch (cause) { toast(cause.message); keep.disabled = false; }
  });
  if (existing && !state.workspace.roles.length) keep.disabled = true;
  controls.append(roleSelect, keep); box.append(controls); return box;
}
function renderResearch() {
  const container = $('#research-result'); const job = state.jobs.find(item => item.id === state.selectedJob);
  container.replaceChildren(); container.setAttribute('aria-busy', String(job?.status === 'running'));
  $('#result-count').hidden = !job;
  if (!job) {
    const node = el('div', 'empty-state'); node.append(el('div', 'empty-art', '⌕'), el('h3', '', 'Your next prospect starts here.'), el('p', '', 'Enter a person and website. Published contacts, source context, and coverage will appear together.'));
    const path = el('div', 'empty-path'); for (const text of ['Research', '→', 'Review', '→', 'Keep']) path.append(el('span', '', text)); node.append(path); container.append(node); return;
  }
  $('#result-count').textContent = `${job.results?.length || 0} found`;
  const summary = el('div', 'result-summary'); const identity = el('div'); identity.append(el('h3', '', jobName(job)), el('p', '', [job.input?.company || job.input?.domain, date(job.createdAt)].filter(Boolean).join(' · '))); summary.append(identity, pill(job.status)); container.append(summary);
  if (job.coverage) container.append(coveragePanel(job.coverage));
  if (job.status === 'running') { container.append(stateMessage('Reading public sources…', 'Checking the starting page and relevant links. You can continue working while the research completes.', true)); return; }
  if (job.status === 'error' || job.status === 'interrupted') {
    container.append(stateMessage('This research needs attention.', job.error || 'The search was interrupted before it finished. Start another search to retry this source.', false, true)); return;
  }
  if (!job.results?.length) container.append(stateMessage('No published email found.', 'The pages read did not contain an extractable email. You can still keep this prospect and their research record.'));
  for (const contact of job.results || []) container.append(contactCard(contact, job.id));
  container.append(keepPanel(job));
}
function updateResearchMode() {
  const mode = $('#research-form').elements.mode.value;
  $('#url-fields').hidden = mode === 'paste'; $('#paste-fields').hidden = mode !== 'paste';
  $('#source-url').disabled = mode === 'paste'; $('#source-url').required = mode === 'public';
  $('#source-text').disabled = mode !== 'paste'; $('#source-text').required = mode === 'paste'; $('#paste-url').disabled = mode !== 'paste';
  $('#source-url-label').replaceChildren(el('span', '', mode === 'public' ? 'Public page URL' : 'Starting page'));
  if (mode === 'website') $('#source-url-label').append(document.createTextNode(' '), el('span', 'optional', 'optional with a domain'));
  $('#source-url-help').textContent = mode === 'website' ? 'Follows relevant public links on this website, up to 5 pages. Each finding keeps its source.' : 'Reads this one public professional page. A team, bio, or contact page is a useful starting point.';
  $('#research-submit').textContent = state.submitting ? 'Starting research…' : mode === 'website' ? 'Search website ↗' : mode === 'public' ? 'Read public page ↗' : 'Read source text ↗';
}
function updateSearchLinks() {
  const name = $('#person-name').value.trim(); const company = $('#person-company').value.trim(); const domain = $('#person-domain').value.trim().replace(/^https?:\/\//, '').split('/')[0];
  $('#research-links').hidden = !name && !company && !domain;
  $('#search-person').href = `https://www.google.com/search?q=${encodeURIComponent([name ? `"${name}"` : '', company || domain, 'professional contact'].filter(Boolean).join(' '))}`;
  $('#search-domain').href = `https://www.google.com/search?q=${encodeURIComponent([domain ? `site:${domain}` : company, name ? `"${name}"` : '', 'contact'].filter(Boolean).join(' '))}`;
}
async function pollJobs() {
  if (state.polling) return;
  state.polling = true;
  try {
    while (state.jobs.some(job => job.status === 'running')) {
      await new Promise(resolve => setTimeout(resolve, 900));
      const running = state.jobs.filter(job => job.status === 'running');
      for (const job of running) {
        const result = await json(`/api/jobs/${encodeURIComponent(job.id)}`); upsertJob(result.job);
      }
      renderMetrics(); renderHistory(); renderResearch();
    }
  } catch (cause) { error('#global-error', cause.message); }
  finally { state.polling = false; }
}
async function refreshWorkspace() { state.workspace = await json('/api/workspace'); }
function candidateRoles(candidateId) { return state.workspace.memberships.filter(membership => membership.candidateId === candidateId); }
function importedObservation(candidate) {
  const provenance = candidate.provenance;
  if (!provenance?.kind?.startsWith('imported_')) return null;
  const detail = el('details', 'observation-detail');
  detail.append(el('summary', '', 'Original observation & import limits'));
  const fields = el('dl', 'observation-fields');
  const add = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    const row = el('div', 'observation-row');
    row.append(el('dt', '', label), el('dd', '', Array.isArray(value) ? value.join('\n') : typeof value === 'object' ? JSON.stringify(value) : value));
    fields.append(row);
  };
  add('Observation kind', provenance.kind);
  add('Original source project', provenance.sourceProject || candidate.sourceProject);
  add('Original source/person ID', provenance.sourceId || candidate.sourceId);
  add('Original observation time', provenance.observedAt || 'Not supplied');
  add('Import content hash', provenance.importHash ? provenance.importHash.slice(0, 16) : 'Not supplied');
  add('Source authority', provenance.authority);
  const upstream = provenance.upstream || {};
  const metadata = [
    ['searchId', 'Original search ID'], ['search_run_id', 'Original search run ID'],
    ['current_title', 'Upstream current title'], ['currentTitle', 'Upstream current title'],
    ['profession', 'Upstream profession'], ['specialty', 'Upstream specialty'], ['credentials', 'Upstream credentials'],
    ['identity_state', 'Upstream identity state'], ['anchor', 'Upstream anchor'],
    ['independent_sources', 'Upstream independent source count'], ['corroborated', 'Upstream corroboration state'],
    ['email', 'Upstream email metadata'], ['email_status', 'Upstream email status'], ['email_source', 'Upstream email source label'],
    ['pipeline_stage', 'Upstream pipeline stage'], ['saved_at', 'Upstream saved time'], ['last_observed_at', 'Upstream last observation'],
    ['createdAt', 'Upstream creation time'], ['profileUrls', 'Upstream profile references'],
  ];
  for (const [key, label] of metadata) add(label, upstream[key]);
  add('Contact source evidence', provenance.contactEvidence === 'not_supplied' ? 'Not supplied by this import' : provenance.contactEvidence || 'Not supplied');
  detail.append(fields);
  detail.append(el('p', 'observation-limit', 'Email metadata only: no source-backed person association. Deliverability is unknown. Imported email metadata cannot export as an approved contact. Separate public-source research and human review are required.'));
  detail.append(el('p', 'observation-limit', 'Upstream identity, credentials, and pipeline states remain original observations. This import does not verify them or change this workspace’s recruiting stage.'));
  if (provenance.kind === 'imported_workspace_subset') detail.append(el('p', 'observation-limit', 'TalentOS v1 carries a role/candidate subset. Detailed contact evidence, original dispositions, notice history, and generated artifacts are not supplied.'));
  return detail;
}
function renderCandidates() {
  const list = $('#candidate-list'); list.replaceChildren();
  const query = $('#candidate-filter').value.trim().toLocaleLowerCase();
  const allCandidates = state.workspace.candidates;
  const candidates = allCandidates.filter(candidate => [candidate.name, candidate.company, candidate.location, candidate.notes].join(' ').toLocaleLowerCase().includes(query));
  $('#candidate-count').textContent = query ? `${candidates.length} of ${counted(allCandidates.length, 'candidate')}` : counted(candidates.length, 'candidate');
  if (!candidates.length) {
    const empty = stateMessage(query ? 'No matching candidates.' : 'Build your talent library.', query ? 'Try a different name, company, or note.' : 'Keep a researched prospect, add a recruiter record, or import selected records from another project.');
    empty.classList.add('panel'); list.append(empty); return;
  }
  for (const candidate of candidates) {
    const card = el('article', 'panel candidate-card');
    const top = el('div', 'candidate-top'); const copy = el('div'); copy.append(el('h2', '', candidate.name), el('p', '', [candidate.company, candidate.location].filter(Boolean).join(' · ') || 'Recruiter record'));
    top.append(el('span', 'avatar', initials(candidate.name)), copy); card.append(top);
    const origin = el('p', 'candidate-origin', `Origin · ${candidate.sourceProject || 'recruiter'}`);
    if (candidate.sourceId) origin.append(el('br'), el('code', '', `Source record ${candidate.sourceId}`));
    card.append(origin);
    const observation = importedObservation(candidate); if (observation) card.append(observation);
    if (candidate.profileUrl) card.append(safeLink(candidate.profileUrl, 'Open profile reference ↗', 'candidate-profile'));
    if (candidate.notes) card.append(el('p', 'candidate-notes', candidate.notes));
    if (candidate.excluded) card.append(el('p', 'observation-limit', 'Excluded in this workspace. Source history is retained; this person is withheld from use.'));
    const memberships = candidateRoles(candidate.id);
    if (memberships.length) {
      const badges = el('div', 'candidate-roles');
      for (const membership of memberships) {
        const role = state.workspace.roles.find(item => item.id === membership.roleId);
        if (role) badges.append(el('span', 'role-badge', `${role.title} · ${stageLabel(membership.stage)}`));
      }
      card.append(badges);
    }
    if (candidate.contacts?.length) {
      const evidence = el('details'); evidence.append(el('summary', '', `${candidate.contacts.length} published contact${candidate.contacts.length === 1 ? '' : 's'} · review & source evidence`));
      for (const contact of candidate.contacts) evidence.append(contactCard(contact, candidate.sourceId));
      card.append(evidence);
    } else card.append(el('p', 'field-help', 'No source-backed email contacts attached.'));
    const snapshotPanel = el('div', 'candidate-snapshot-panel'); snapshotPanel.hidden = true;
    const snapshotButton = action('Inspect saved evidence', 'button secondary small', async () => {
      snapshotButton.disabled = true; snapshotPanel.hidden = false; snapshotPanel.replaceChildren(el('p', 'field-help', 'Reading retained evidence…'));
      try {
        const result = await json(`/api/candidates/${encodeURIComponent(candidate.id)}/evidence`);
        snapshotPanel.replaceChildren();
        if (!result.snapshots?.length) snapshotPanel.append(el('p', 'field-help', 'No live source snapshot is retained for this candidate. Contact research, if present, stays attached above.'));
        for (const snapshot of result.snapshots || []) {
          const detail = el('details', 'saved-snapshot'); detail.open = true;
          detail.append(el('summary', '', `${sourceLabel(snapshot.sourceProject)} · ${date(snapshot.selectedAt || snapshot.observedAt || snapshot.createdAt) || 'Time not supplied'}`));
          detail.append(el('p', 'source-lineage', `Original record ${snapshot.sourceRecordId || snapshot.sourceId || 'Not supplied'} · Snapshot ${snapshot.id || 'Not supplied'}`));
          if (snapshot.digest || snapshot.snapshotHash) detail.append(el('p', 'source-lineage', `Evidence digest ${snapshot.digest || snapshot.snapshotHash}`));
          detail.append(evidenceDocument(snapshot.document || snapshot, snapshot.sourceProject)); snapshotPanel.append(detail);
        }
      } catch (cause) { snapshotPanel.replaceChildren(el('p', 'form-error', cause.message)); }
      finally { snapshotButton.disabled = false; }
    });
    const evidenceActions = el('div', 'source-search-actions'); evidenceActions.append(snapshotButton);
    if (candidate.npi) {
      const vitalcvButton = action('Read VitalCV credential evidence', 'button secondary small', async () => {
        vitalcvButton.disabled = true; snapshotPanel.hidden = false; snapshotPanel.replaceChildren(el('p', 'field-help', `Reading public credential claims for exact NPI ${candidate.npi}…`));
        try {
          const result = await post(`/api/candidates/${encodeURIComponent(candidate.id)}/vitalcv`, {});
          snapshotPanel.replaceChildren(evidenceDocument(result.snapshot?.document || result.snapshot || {}, 'vitalcv'));
          await refreshWorkspace(); toast('VitalCV observation retained. Qualification remains unknown and requires review.');
        } catch (cause) { snapshotPanel.replaceChildren(el('p', 'form-error', cause.message)); }
        finally { vitalcvButton.disabled = false; }
      });
      vitalcvButton.disabled = candidate.excluded === true; evidenceActions.append(vitalcvButton);
    } else snapshotPanel.append(el('p', 'field-help', 'A source-backed exact NPI is required for VitalCV credential reads.'));
    card.append(evidenceActions, snapshotPanel);
    if (state.workspace.roles.length) {
      const add = el('div', 'candidate-add'); const roleSelect = el('select'); roleSelect.setAttribute('aria-label', `Role for ${candidate.name}`); roleOptions(roleSelect, 'Choose a role');
      const addButton = action('Add to role', 'button secondary small', async () => {
        if (!roleSelect.value) { toast('Choose a role first.'); roleSelect.focus(); return; }
        addButton.disabled = true;
        try { await post('/api/pipeline', { roleId: roleSelect.value, candidateId: candidate.id }); await refreshWorkspace(); renderAll(); toast('Candidate added to the role.'); }
        catch (cause) { toast(cause.message); addButton.disabled = false; }
      });
      addButton.disabled = candidate.excluded === true;
      add.append(roleSelect, addButton); card.append(add);
    }
    list.append(card);
  }
}
async function downloadPipeline(roleId, control) {
  control.disabled = true;
  try {
    const response = await api(`/api/pipeline/export?roleId=${encodeURIComponent(roleId)}&format=csv`);
    const objectUrl = URL.createObjectURL(await response.blob()); const link = el('a'); link.href = objectUrl; link.download = 'role-pipeline.csv'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); toast('Pipeline exported. Email columns include confirmed, non-excluded contacts only.');
  } catch (cause) { toast(cause.message); }
  finally { control.disabled = false; }
}
function renderRoles() {
  const list = $('#role-list'); list.replaceChildren();
  $('#role-count').textContent = state.workspace.roles.length;
  if (!state.workspace.roles.some(role => role.id === state.selectedRole)) state.selectedRole = state.workspace.roles[0]?.id || null;
  for (const role of state.workspace.roles) {
    const memberships = state.workspace.memberships.filter(member => member.roleId === role.id);
    const item = action('', `role-item${role.id === state.selectedRole ? ' active' : ''}`, () => { state.selectedRole = role.id; renderRoles(); });
    item.setAttribute('aria-pressed', String(role.id === state.selectedRole));
    item.append(el('strong', '', role.title), el('p', '', [role.company, role.location].filter(Boolean).join(' · ') || 'Open role'), el('span', '', `${counted(memberships.length, 'candidate')} · ${stageLabel(role.status)}`)); list.append(item);
  }
  if (!state.workspace.roles.length) list.append(el('p', 'small-empty', 'Create your first role to start a pipeline.'));
  const content = $('#pipeline-content'); content.replaceChildren();
  const role = state.workspace.roles.find(item => item.id === state.selectedRole);
  if (!role) { content.append(stateMessage('A focused pipeline starts with a role.', 'Create a role brief, then keep researched prospects or add people from your candidate library.')); return; }
  const header = el('div', 'pipeline-heading'); const identity = el('div'); identity.append(el('h2', '', role.title), el('p', '', [role.company, role.location].filter(Boolean).join(' · ') || 'Open role'));
  const exportButton = action('Export pipeline ↓', 'button secondary small', () => downloadPipeline(role.id, exportButton)); header.append(identity, exportButton); content.append(header);
  if (role.description) content.append(el('p', 'pipeline-brief', role.description));
  if(role.provenance?.sourceId) content.append(el('p','source-lineage',`Original ${sourceLabel(role.provenance.sourceProject)} role ${role.provenance.sourceId} · Saved source snapshot ${role.provenance.snapshotId || 'not supplied'}`));
  if(role.criteria?.length) { const details=el('details','source-reference-list'); details.append(el('summary','',`${role.criteria.length} saved upstream role criteria`)); for(const criterion of role.criteria) { const item=el('div','source-observation'); item.append(el('strong','',criterion.text || criterion.statement || 'Criterion'),el('p','source-lineage',`${criterion.sourceRecordId || criterion.id} · ${criterion.status || 'unreviewed'} · Quote support ${criterion.quoteSupport || 'unknown'}`));if(criterion.statement)item.append(el('blockquote','',criterion.statement));if(criterion.contested)appendSourceNote(item,'Contested upstream criterion.');details.append(item); }details.append(el('p','field-help','Source phrases and upstream interpretations do not establish candidate fit.'));content.append(details); }
  const memberships = state.workspace.memberships.filter(member => member.roleId === role.id);
  const overview = el('div', 'stage-overview');
  for (const stage of state.workspace.stages || stages) {
    const tally = el('span', '', stageLabel(stage)); tally.append(el('strong', '', memberships.filter(member => member.stage === stage).length)); overview.append(tally);
  }
  content.append(overview);
  if (!memberships.length) {
    const empty = stateMessage('Your shortlist is ready for people.', 'Select this role when keeping a prospect, or add a saved candidate from the library.');
    empty.append(action('Research a prospect ↗', 'button secondary small', () => { $('#research-role').value = role.id; $('#view-research .optional-details').open = true; showView('research'); $('#person-name').focus(); })); content.append(empty);
  }
  for (const member of memberships) {
    const candidate = state.workspace.candidates.find(item => item.id === member.candidateId); if (!candidate) continue;
    const row = el('div', 'pipeline-row'); const identity = el('div'); identity.append(el('h3', '', candidate.name), el('p', '', candidate.company || candidate.sourceProject || 'Recruiter record'));
    const stageSelect = el('select'); stageSelect.setAttribute('aria-label', `Pipeline stage for ${candidate.name}`);
    for (const stage of state.workspace.stages || stages) { const option = el('option', '', stageLabel(stage)); option.value = stage; stageSelect.append(option); }
    stageSelect.value = member.stage; stageSelect.disabled = !!candidate.excluded;
    if(candidate.excluded) identity.append(pill('suppressed','Excluded from use and export'));
    stageSelect.addEventListener('change', async () => {
      stageSelect.disabled = true;
      try { await post('/api/pipeline/stage', { roleId: role.id, candidateId: candidate.id, stage: stageSelect.value }); await refreshWorkspace(); renderAll(); toast('Recruiting stage recorded.'); }
      catch (cause) { stageSelect.value = member.stage; stageSelect.disabled = !!candidate.excluded;
    if(candidate.excluded) identity.append(pill('suppressed','Excluded from use and export')); stageSelect.disabled = false; toast(cause.message); }
    });
    const approved = (candidate.contacts || []).filter(contact => contact.review === 'approved');
    const contactStatus = approved.length ? `${approved.length} confirmed contact${approved.length > 1 ? 's' : ''} · delivery unknown` : candidate.contacts?.length ? 'Contact review pending' : 'No approved email';
    row.append(identity, stageSelect, el('span', 'contact-status', contactStatus)); content.append(row);
  }
  content.append(el('p', 'pipeline-note', 'Stages are recruiter records. Selecting “Contacted” records a stage; this workspace does not send a message. Exports include approved, non-excluded email contacts only.'));
}
function renderProjects() {
  const projects = $('#project-list'); projects.replaceChildren(); $('#project-count').textContent = counted(state.projects.length, 'project');
  for (const project of state.projects) {
    const row = el('article', 'project-row'); const header = el('div', 'project-title');
    header.append(el('h3', '', project.label || project.name || project.id), pill('', projectStatus(project.integrationStatus || project.status || project.ownerStatus || 'inventoried'))); row.append(header);
    if (project.role) row.append(el('p', '', project.role));
    const detail = el('details'); detail.append(el('summary', '', 'Original project & evidence boundary'));
    if (project.path || project.sourcePath) detail.append(el('div', 'project-path', project.path || project.sourcePath));
    if (project.dataPolicy) detail.append(el('p', 'project-policy', project.dataPolicy));
    if (project.head) detail.append(el('p', 'project-policy', `Observed revision · ${project.head.slice(0, 12)}`));
    row.append(detail); projects.append(row);
  }
  if (!state.projects.length) projects.append(el('p', 'small-empty', 'No source projects are registered yet.'));
  const integrations = $('#integration-list'); integrations.replaceChildren();
  for (const integration of state.integrations) {
    const card = el('article', 'integration-card'); card.append(el('h3', '', integration.label || integration.name || integration.id), pill(integration.status === 'connected' || integration.status === 'available' ? 'approved' : 'pending', stageLabel(integration.status || 'unknown')));
    if (integration.message) card.append(el('p', '', integration.message));
    if (integration.endpoint) card.append(safeLink(integration.endpoint, 'Service endpoint ↗', 'candidate-profile')); integrations.append(card);
  }
  const importHistory = $('#import-history'); importHistory.replaceChildren();
  if (state.workspace.imports.length) {
    importHistory.className = 'import-history'; importHistory.append(el('h3', '', 'Import history'));
    for (const record of state.workspace.imports.slice(0, 10)) importHistory.append(el('p', '', `${stageLabel(record.format || record.sourceProject || 'Import')} · ${counted(record.candidatesCreated ?? record.candidateCount ?? 0, 'candidate')} · ${date(record.createdAt || record.at)}`));
  }
}
function sourceLabel(project) {
  return ({ 'candidate-intelligence-os': 'Candidate Intelligence', 'candidate-os': 'Candidate Intelligence', talentos: 'TalentOS', vitalcv: 'VitalCV' })[project] || stageLabel(project || 'Source');
}
function recordId(record) { return record?.sourceId || record?.id || record?.personId || record?.person_id; }
function recordName(record) { return record?.name || record?.fullName || record?.displayName || 'Unnamed source record'; }
function appendSourceNote(container, value) {
  if (typeof value === 'string' && value) container.append(el('p', 'observation-limit', value));
}
function evidenceDocument(document, project) {
  const container = el('div', 'evidence-document');
  const person = document.person || document.candidate || document.subject || {};
  const identity = el('div', 'source-facts');
  for (const [label, value] of [['Source project', sourceLabel(project || document.projectId || document.sourceProject)], ['Source record', recordId(person)], ['Source read status', document.status ? stageLabel(document.status) : null], ['Exact NPI', person.npi], ['Source observation time', document.observedAt || person.observedAt], ['Source version', document.sourceVersion || document.service?.gitSha], ['Authority', person.authority || document.authority], ['Qualification', document.qualificationState], ['Identity association', document.credentialAssociation]]) {
    if (value === undefined || value === null || value === '') continue;
    const field = el('div'); field.append(el('span', '', label), el('strong', '', value)); identity.append(field);
  }
  if (identity.childNodes.length) container.append(identity);
  if (document.verification?.decisionGrade === false || project === 'vitalcv') container.append(el('p', 'observation-limit', 'Credential qualification unknown · Independent acceptance unassessed · Decision-grade evidence: no.'));
  if (person.excluded || document.excluded) container.append(el('p', 'form-error', 'This source record is excluded. Its retained history is for review only.'));
  for (const message of [...(document.limitations || document.limits?.limitations || []), ...(document.warnings || []), ...(person.warnings || [])]) appendSourceNote(container, message);
  if (document.limits && typeof document.limits === 'object') {
    const values = Object.entries(document.limits).filter(([,value])=>typeof value === 'number' || typeof value === 'boolean').map(([key,value])=>`${stageLabel(key)}: ${value}`);
    if (values.length) container.append(el('p','source-lineage',`Evidence read limits · ${values.join(' · ')}`));
  }
  const observations = document.evidence || person.evidence || document.facts || [];
  const references = document.sources || person.sources || [];
  if(document.truncated) appendSourceNote(container,'This selected-source read reached an evidence limit. The retained observation is partial; review the original source for complete history.');
  if (observations.length) {
    container.append(el('h3', 'source-section-title', 'Original source observations'));
    const appendObservation = (target,observation) => {
      if(Array.isArray(observation.assertions)) {
        const group=el('details','source-observation source-assertion-group');
        group.append(el('summary','',`${observation.sourceName || observation.title || 'Source record'} · ${counted(observation.assertions.length,'assertion')}`));
        if(observation.url) group.append(safeLink(observation.url));
        group.append(el('p','source-lineage',`Evidence record ${observation.id || 'Not supplied'} · Source ${observation.sourceId || observation.externalId || 'Not supplied'} · ${observation.observedAt || 'Time not supplied'}`));
        if(observation.contentHash) group.append(el('p','source-lineage',`Content digest ${observation.contentHash}`));
        for(const assertion of observation.assertions) appendObservation(group,{url:observation.url,evidenceRecordId:observation.id,...assertion});
        target.append(group); return;
      }
      const item = el('article', 'source-observation');
      const head = el('div', 'source-observation-heading');
      head.append(el('h3', '', observation.title || observation.predicate || observation.type || observation.criterion || 'Source observation'), pill('unknown', stageLabel(observation.status || observation.upstreamStatus || observation.verificationStatus || 'unverified'))); item.append(head);
      const sourceUrl = observation.url || observation.sourceUrl || observation.source_url;
      if (sourceUrl) item.append(safeLink(sourceUrl));
      const observedAt = observation.sourceObservedAt || observation.observedAt || observation.retrievedAt || observation.retrieved_at;
      item.append(el('p', 'source-lineage', `Record ${observation.sourceRecordId || observation.id || observation.claimId || 'Not supplied'}${observation.evidenceRecordId ? ` · Evidence ${observation.evidenceRecordId}` : ''} · ${observedAt || 'Observation time not supplied'}`));
      item.append(el('p', 'source-lineage', `Quote kind · ${stageLabel(observation.quoteKind || observation.quote_kind || 'not supplied')} · Authority · ${stageLabel(observation.authority || observation.provenance || 'upstream observation')}`));
      if(['string','number','boolean'].includes(typeof observation.value)) item.append(el('p','source-assertion-value',String(observation.value)));
      const quote = observation.quote || observation.snippet || observation.context || observation.evidenceText;
      if (typeof quote === 'string' && quote) item.append(el('blockquote', '', quote));
      else item.append(el('p', 'field-help', 'No verbatim source quote supplied.'));
      if (observation.quoteTruncated) appendSourceNote(item, 'This quote is a bounded excerpt. The original record remains authoritative.');
      if (observation.retractedAt || observation.retracted_at || observation.isRetracted || observation.retracted || /retract|withdraw|revoke/i.test(String(observation.status || observation.upstreamStatus || ''))) appendSourceNote(item, `Retraction or revocation reported by upstream${observation.retractedAt || observation.retracted_at ? ` · ${observation.retractedAt || observation.retracted_at}` : ''}. Retained history is not current qualification evidence.`);
      else if(observation.current === false) appendSourceNote(item,'Historical assertion. This is not a current qualification observation.');
      if (observation.reviewRequired !== undefined) appendSourceNote(item, `Upstream review required: ${observation.reviewRequired ? 'yes' : 'no'}. Independent credential acceptance remains unassessed.`);
      if (observation.freshness?.state) appendSourceNote(item, `Freshness · ${stageLabel(observation.freshness.state)}${observation.freshness.validUntil ? ` · Valid until ${observation.freshness.validUntil}` : ''}`);
      for (const warning of observation.limitations || []) appendSourceNote(item, warning);
      target.append(item);
    };
    for(const observation of observations) appendObservation(container,observation);
  } else container.append(el('p', 'field-help', 'No source-supported qualification observations were supplied. A profile reference alone does not establish fit.'));
  if (references.length) {
    const refs = el('details', 'source-reference-list'); refs.append(el('summary', '', counted(references.length, 'source reference')));
    for (const reference of references) {
      const entry = el('div', 'source-reference'); const url = typeof reference === 'string' ? reference : reference.url || reference.sourceUrl;
      if (url) entry.append(safeLink(url));
      entry.append(el('p', 'source-lineage', `Record ${reference.sourceRecordId || reference.id || reference.sourceId || 'Not supplied'} · ${reference.observedAt || reference.computedAt || 'Time not supplied'}${reference.authority ? ` · ${reference.authority}` : ''}`));
      if (reference.runtimeState) appendSourceNote(entry, `Source runtime · ${reference.runtimeState} · Freshness ${reference.freshnessStatus || 'unknown'}`);
      if (reference.limitation) appendSourceNote(entry, reference.limitation);
      refs.append(entry);
    }
    container.append(refs);
  }
  const profileUrls = person.profileUrls || (person.profileUrl ? [person.profileUrl] : []);
  if (profileUrls.length && !references.length) for (const url of profileUrls) container.append(safeLink(url, 'Open public profile reference ↗', 'candidate-profile'));
  const contacts = document.contacts || person.contacts || [];
  container.append(el('h3', 'source-section-title', 'Contact observations'));
  if (!contacts.length) container.append(el('p', 'field-help', 'No published email observation supplied. Deliverability remains unknown.'));
  for (const contact of contacts) {
    const item = el('article', 'source-contact-observation');
    item.append(el('strong', '', contact.email || contact.value || 'Contact value not supplied'), el('p', 'field-help', `Person association · ${stageLabel(contact.review || contact.ownership || 'unreviewed')} · Deliverability unknown`));
    if (contact.excluded || contact.review === 'suppressed') appendSourceNote(item, 'Excluded globally. Withheld from use and export.');
    if(contact.sourceUrl) item.append(safeLink(contact.sourceUrl));
    if(contact.observedAt) item.append(el('p','source-lineage',`Observed ${contact.observedAt} · Evidence ${contact.evidenceId || 'Not supplied'}`));
    if(contact.quote) item.append(el('blockquote','',contact.quote));
    if(contact.evidenceSupported === false || contact.actionable === false) appendSourceNote(item,'This upstream contact observation is not actionable. Source association and human review remain required.');
    for (const source of contact.sources || []) {
      if (source.url || source.sourceUrl) item.append(safeLink(source.url || source.sourceUrl));
      if (source.observedAt) item.append(el('p', 'source-lineage', `Observed ${source.observedAt}`));
      if (source.quote || source.context) item.append(el('blockquote', '', source.quote || source.context));
    }
    container.append(item);
  }
  if (document.coverage?.length) {
    const coverage = el('details', 'source-reference-list'); coverage.append(el('summary', '', 'Credential read coverage'));
    for (const row of document.coverage) { const entry = el('div', 'source-reference'); entry.append(safeLink(row.sourceUrl || row.url), el('p', 'source-lineage', `${stageLabel(row.status)} · ${row.observedAt || 'Time not supplied'}`)); if (row.error) appendSourceNote(entry,row.error); coverage.append(entry); }
    container.append(coverage);
  }
  return container;
}
function renderLiveSources() {
  const list = $('#live-source-status'); list.replaceChildren();
  if (!state.liveSources.length) { list.append(el('p', 'small-empty', 'Source connection status has not been read. Refresh connections to inspect the configured readers.')); return; }
  for (const source of state.liveSources) {
    const card = el('article', 'live-status-card');
    const status = source.status || source.state || (source.available ? 'available' : source.configured ? 'configured' : 'not_configured');
    card.append(el('h3', '', sourceLabel(source.projectId || source.sourceProject)), pill(/available|online|read_only/.test(status) ? '' : 'unknown', stageLabel(status)));
    card.append(el('p', '', source.readOnly ? 'Read-only source connection' : source.projectId === 'vitalcv' ? 'Public GET evidence adapter' : 'Connection mode not supplied'));
    if (source.counts) card.append(el('p', 'source-lineage', Object.entries(source.counts).filter(([,value])=>typeof value === 'number').map(([key,value])=>`${stageLabel(key)}: ${value}`).join(' · ')));
    if (source.observedAt) card.append(el('p', 'source-lineage', `Read ${source.observedAt}`));
    if (source.message || source.error) card.append(el('p', 'field-help', source.message || source.error));
    for (const limitation of source.limitations || []) appendSourceNote(card,limitation);
    list.append(card);
  }
}
async function refreshLiveSources() {
  const button = $('#refresh-live-sources'); button.disabled = true; error('#live-source-error','');
  try { const result = await json('/api/sources/status'); state.liveSources = result.sources || []; renderLiveSources(); }
  catch(cause) { error('#live-source-error',cause.message); }
  finally { button.disabled = false; }
}
async function inspectSource(project, record, kind='candidate') {
  const request = ++state.sourceRequest;
  error('#live-source-error',''); $('#live-source-detail').replaceChildren(stateMessage('Reading original evidence…','Selected source records stay in their original stores.',true));
  try {
    const id = recordId(record);
    const path = kind === 'role' ? `/api/sources/talentos/roles/${encodeURIComponent(id)}` : `/api/sources/${project === 'talentos' ? 'talentos' : 'candidate-os'}/people/${encodeURIComponent(id)}/evidence`;
    const document = await json(path); if(request !== state.sourceRequest) return;
    state.sourceDetail = {project,record,kind,document}; renderSourceDetail();
  } catch(cause) { if(request === state.sourceRequest) { state.sourceDetail = null; $('#live-source-detail').replaceChildren(stateMessage('Source evidence unavailable.',cause.message,false,true)); } }
}
function renderSourceResults() {
  const list = $('#live-source-results'); list.replaceChildren(); const result = state.sourceResults;
  if(!result) { list.append(el('p','small-empty','Search candidates or browse source roles to start.')); return; }
  list.append(el('p','source-results-heading',`${sourceLabel(result.project)} · ${counted(result.records.length,result.kind === 'role' ? 'role' : 'candidate')}`));
  if(result.truncated) appendSourceNote(list,`This is a partial source result set${result.candidatesConsidered !== undefined ? `; ${result.candidatesConsidered} records considered in a window of ${result.candidateWindow || 'unknown'}` : ''}. Narrow the keywords to inspect another selection.`);
  if(!result.records.length) list.append(el('p','small-empty','No supported public-source records matched this selection.'));
  for(const record of result.records) {
    const card=el('article','source-result-card'); card.append(el('h3','',result.kind === 'role' ? record.title : recordName(record)),el('p','field-help',[record.company || record.currentCompany || record.currentOrganization,record.title && result.kind !== 'role' ? record.title : '',record.location].filter(Boolean).join(' · ')));
    card.append(el('p','source-lineage',`Original ID ${recordId(record) || 'Not supplied'}`));
    if(record.excluded) card.append(pill('suppressed','Excluded'));
    const inspect=action(result.kind === 'role' ? 'Inspect role criteria' : 'Inspect source evidence','button secondary small',()=>inspectSource(result.project,record,result.kind)); card.append(inspect); list.append(card);
  }
}
function renderSourceDetail() {
  const box=$('#live-source-detail'); box.replaceChildren(); const detail=state.sourceDetail;
  if(!detail) { box.append(stateMessage('Inspect before keeping.','Select a source record to read its evidence, original status, and limitations.')); return; }
  const record=detail.document.role || detail.document.person || detail.document.candidate || detail.record;
  box.append(el('h3','source-detail-name',detail.kind === 'role' ? record.title : recordName(record)),el('p','source-lineage',`${sourceLabel(detail.project)} · Original ID ${recordId(record) || recordId(detail.record)}`));
  if(detail.kind === 'role') {
    if(record.description) box.append(el('blockquote','role-source-brief',record.description));
    for(const criterion of record.criteria || []) {
      const item=el('article','source-observation'); item.append(el('h3','',criterion.text || criterion.label || 'Criterion'),el('p','source-lineage',`${stageLabel(criterion.kind)} · ${stageLabel(criterion.status)} · Origin ${criterion.provenance || criterion.origin || 'unknown'}`));
      if(criterion.statement) item.append(el('blockquote','',criterion.statement)); if(criterion.definition) item.append(el('p','field-help',criterion.definition));
      item.append(el('p','source-lineage',`Source record ${criterion.sourceRecordId || criterion.id || 'Not supplied'} · Quote support ${stageLabel(criterion.quoteSupport || 'unknown')} · ${criterion.observedAt || 'Time not supplied'}`));
      if(criterion.contested) appendSourceNote(item,'Upstream stakeholders disagree about this criterion.');
      appendSourceNote(item,'Upstream derived criterion. This does not establish candidate fit.'); box.append(item);
    }
    for(const warning of record.warnings || []) appendSourceNote(box,warning);
    const imported=action('Import selected role','button primary',async()=>{
      imported.disabled=true;
      try { const result=await post('/api/import-source-role',{sourceId:recordId(detail.record)}); await refreshWorkspace(); state.selectedRole=result.role?.id || state.selectedRole; renderAll(); toast(result.reused ? 'Source role is already retained. New observations remain reviewable.' : 'Selected role imported with source criteria and original lineage.'); }
      catch(cause) { error('#live-source-error',cause.message); imported.disabled=false; }
    }); box.append(imported); return;
  }
  box.append(evidenceDocument(detail.document,detail.project));
  const excluded=record.excluded || detail.document.excluded;
  const controls=el('div','source-keep-controls'); const roleSelect=el('select'); roleSelect.setAttribute('aria-label',`Destination role for ${recordName(record)}`); roleOptions(roleSelect);
  const keep=action('Keep selected source candidate','button primary',async()=>{
    keep.disabled=true; const roleId=roleSelect.value;
    try { const result=await post('/api/keep-source',{sourceProject:detail.project,sourceId:recordId(detail.record),...(roleId ? {roleId} : {})}); await refreshWorkspace(); renderAll(); toast(result.reused ? 'Candidate already retained; source observation preserved.' : 'Selected source candidate kept. Contact ownership remains unreviewed.'); }
    catch(cause) { error('#live-source-error',cause.message); keep.disabled=false; }
  }); keep.disabled=!!excluded; controls.append(roleSelect,keep); box.append(el('p','field-help','Keeping preserves this source observation. It does not approve an email, inherit an upstream pipeline outcome, or verify credentials.'),controls);
}
function renderAll() { renderMetrics(); renderHistory(); renderResearch(); renderCandidates(); renderRoles(); renderProjects(); renderLiveSources(); renderSourceResults(); renderSourceDetail(); }
function clearImportPreview() { state.importPreview = null; $('#import-preview').hidden = true; $('#import-preview').replaceChildren(); }
function renderImportPreview(preview) {
  const container = $('#import-preview'); container.replaceChildren(); container.className = 'import-preview'; container.hidden = false;
  container.append(el('h3', '', 'Review this import'), el('p', '', `${counted(preview.candidates || 0, 'candidate record')} · ${counted(preview.roles || 0, 'role')}. Nothing has been added yet.`));
  if (preview.samples?.length) {
    const list = el('ul');
    for (const sample of preview.samples) list.append(el('li', '', [sample.name, sample.company, sample.location].filter(Boolean).join(' · '))); container.append(list);
  }
  for (const warning of preview.warnings || []) container.append(el('p', '', warning));
  const commit = action('Import these records', 'button primary small', async () => {
    if (!state.importPreview) return;
    commit.disabled = true;
    try {
      const result = await post('/api/import', { format: state.importPreview.format, content: state.importPreview.content, commit: true });
      await refreshWorkspace(); renderAll(); clearImportPreview();
      toast(`Imported ${counted(result.import?.candidatesCreated || 0, 'candidate')} and ${counted(result.import?.rolesCreated || 0, 'role')}. Source lineage retained.`);
    } catch (cause) { error('#import-error', cause.message); commit.disabled = false; }
  });
  if (!preview.candidates && !preview.roles) commit.disabled = true;
  container.append(commit);
}

$('#refresh-live-sources').addEventListener('click',refreshLiveSources);
$('#live-source-project').addEventListener('change',()=>{
  state.sourceRequest++; state.sourceResults=null; state.sourceDetail=null; error('#live-source-error',''); renderSourceResults(); renderSourceDetail();
});
$('#live-source-form').addEventListener('submit',async event=>{
  event.preventDefault(); const button=$('#live-source-search'); button.disabled=true; error('#live-source-error','');
  const project=$('#live-source-project').value, query=$('#live-source-query').value.trim();
  const request=++state.sourceRequest; state.sourceDetail=null; renderSourceDetail();
  $('#live-source-results').replaceChildren(el('p','small-empty','Reading selected public-source records…'));
  try {
    const result=await json(`/api/sources/${project === 'talentos' ? 'talentos' : 'candidate-os'}/people?${project === 'talentos' ? 'query' : 'q'}=${encodeURIComponent(query)}&limit=25`);
    if(request !== state.sourceRequest) return;
    state.sourceResults={project,kind:'candidate',records:result.people || result.candidates || [],truncated:result.truncated || result.limited,candidatesConsidered:result.candidatesConsidered,candidateWindow:result.candidateWindow}; renderSourceResults();
    for(const warning of result.warnings || []) appendSourceNote($('#live-source-results'),warning);
  } catch(cause) { if(request === state.sourceRequest) { state.sourceResults=null; renderSourceResults(); error('#live-source-error',cause.message); } }
  finally { button.disabled=false; }
});
$('#load-talentos-roles').addEventListener('click',async()=>{
  const button=$('#load-talentos-roles'); button.disabled=true; error('#live-source-error','');
  const request=++state.sourceRequest; state.sourceDetail=null; renderSourceDetail();
  $('#live-source-results').replaceChildren(el('p','small-empty','Reading TalentOS role records…'));
  try {
    const result=await json('/api/sources/talentos/roles'); if(request !== state.sourceRequest) return;
    state.sourceResults={project:'talentos',kind:'role',records:result.roles || []}; renderSourceResults();
  } catch(cause) { if(request === state.sourceRequest) { state.sourceResults=null; renderSourceResults(); error('#live-source-error',cause.message); } }
  finally { button.disabled=false; }
});

for (const node of document.querySelectorAll('[data-view]')) node.addEventListener('click', () => showView(node.dataset.view));
for (const node of document.querySelectorAll('[data-go]')) node.addEventListener('click', () => { showView(node.dataset.go); if (node.dataset.go === 'roles') { $('#role-form-panel').hidden = false; $('#role-title').focus(); } });
for (const input of document.querySelectorAll('input[name=mode]')) input.addEventListener('change', () => { error('#research-error', ''); updateResearchMode(); });
for (const selector of ['#person-name', '#person-company', '#person-domain']) $(selector).addEventListener('input', updateSearchLinks);
$('#research-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.submitting) return; error('#research-error', '');
  const mode = $('#research-form').elements.mode.value;
  const input = { name: $('#person-name').value.trim(), company: $('#person-company').value.trim(), domain: $('#person-domain').value.trim(), linkedinUrl: $('#person-profile').value.trim() };
  const sourceUrl = mode === 'paste' ? $('#paste-url').value.trim() : $('#source-url').value.trim();
  if (mode === 'website' && !sourceUrl && !input.domain) { error('#research-error', 'Enter a website domain or starting page.'); $('#person-domain').focus(); return; }
  const request = { mode, input, sourceUrl, sourceText: mode === 'paste' ? $('#source-text').value : '', idempotencyKey: crypto.randomUUID() };
  state.submitting = true; $('#research-submit').disabled = true; updateResearchMode();
  try { const result = await post('/api/discover', request); upsertJob(result.job); state.selectedJob = result.job.id; renderAll(); pollJobs(); }
  catch (cause) { error('#research-error', cause.message); }
  finally { state.submitting = false; $('#research-submit').disabled = false; updateResearchMode(); }
});
for (const [toggleId, panelId, inputId] of [['toggle-candidate-form', 'candidate-form-panel', 'candidate-name'], ['toggle-role-form', 'role-form-panel', 'role-title']]) {
  $(`#${toggleId}`).addEventListener('click', () => { $(`#${panelId}`).hidden = !$(`#${panelId}`).hidden; if (!$(`#${panelId}`).hidden) $(`#${inputId}`).focus(); });
}
$('#close-candidate-form').addEventListener('click', () => { $('#candidate-form-panel').hidden = true; });
$('#close-role-form').addEventListener('click', () => { $('#role-form-panel').hidden = true; });
$('#candidate-filter').addEventListener('input', renderCandidates);
$('#candidate-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true; error('#candidate-error', '');
  try {
    const result = await post('/api/candidates', { name: $('#candidate-name').value.trim(), company: $('#candidate-company').value.trim(), location: $('#candidate-location').value.trim(), profileUrl: $('#candidate-profile').value.trim(), notes: $('#candidate-notes').value.trim() });
    if ($('#candidate-role').value) await post('/api/pipeline', { candidateId: result.candidate.id, roleId: $('#candidate-role').value });
    form.reset(); $('#candidate-form-panel').hidden = true; await refreshWorkspace(); renderAll(); toast('Candidate saved with recruiter-supplied context.');
  } catch (cause) { error('#candidate-error', cause.message); }
  finally { submit.disabled = false; }
});
$('#role-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type=submit]'); submit.disabled = true; error('#role-error', '');
  try {
    const result = await post('/api/roles', { title: $('#role-title').value.trim(), company: $('#role-company').value.trim(), location: $('#role-location').value.trim(), description: $('#role-description').value.trim() });
    state.selectedRole = result.role.id; form.reset(); $('#role-form-panel').hidden = true; await refreshWorkspace(); renderAll(); $('#research-role').value = result.role.id; toast('Role created. Add people through Research or Candidates.');
  } catch (cause) { error('#role-error', cause.message); }
  finally { submit.disabled = false; }
});
$('#import-content').addEventListener('input', clearImportPreview); $('#import-format').addEventListener('change', clearImportPreview);
$('#import-file').addEventListener('change', async event => {
  clearImportPreview(); error('#import-error', ''); const file = event.currentTarget.files[0]; if (!file) return;
  if (file.size > 120000) { error('#import-error', 'Choose a selected export up to 120 KB. Split larger exports into smaller selections.'); event.currentTarget.value = ''; return; }
  try { $('#import-content').value = await file.text(); }
  catch { error('#import-error', 'Could not read this file. Try pasting the export text.'); }
});
$('#import-form').addEventListener('submit', async event => {
  event.preventDefault(); clearImportPreview(); error('#import-error', ''); const content = $('#import-content').value; const format = $('#import-format').value;
  if (!content.trim()) { error('#import-error', 'Choose a file or paste export content first.'); return; }
  $('#import-preview-button').disabled = true;
  try { const result = await post('/api/import', { format, content, commit: false }); state.importPreview = { format, content }; renderImportPreview(result.preview); }
  catch (cause) { error('#import-error', cause.message); }
  finally { $('#import-preview-button').disabled = false; }
});
async function start() {
  showView(location.hash.slice(1)); updateResearchMode();
  try {
    const response = await fetch('/api/status', { cache: 'no-store' }); if (!response.ok) throw new Error('The local server did not respond.');
    const status = await response.json(); if (!status.token) throw new Error('The local session could not be established.'); state.token = status.token;
    const [workspace, jobs, projects, integrations] = await Promise.all([json('/api/workspace'), json('/api/jobs'), json('/api/projects'), json('/api/integrations/status')]);
    state.workspace = workspace; state.jobs = jobs.jobs || []; state.projects = projects.projects || []; state.integrations = integrations.integrations || []; state.selectedJob = state.jobs[0]?.id || null;
    $('#connection-label').textContent = 'Connected locally'; $('#connection-dot').className = 'connection-dot connected'; renderAll(); pollJobs(); refreshLiveSources();
  } catch (cause) {
    $('#connection-label').textContent = 'Connection needs attention'; $('#connection-dot').className = 'connection-dot error'; error('#global-error', `${cause.message} Reload after the local server is ready.`);
  }
}
start();
