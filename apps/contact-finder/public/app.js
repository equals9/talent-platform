'use strict';

const $ = selector => document.querySelector(selector);
const form = $('#search-form');
const content = $('#result-content');
const originalEmptyState = content.firstElementChild.cloneNode(true);
const state = { token: null, jobs: [], selectedId: null, submitting: false, polling: false, requests: new Map() };
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, action) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url : null;
  } catch { return null; }
}

function dateLabel(value, includeTime = false) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}) }).format(date);
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}

function showError(id, message) {
  const node = $(id);
  node.textContent = message || '';
  node.hidden = !message;
}

async function api(path, options = {}) {
  if (!state.token) throw new Error('The local server is not connected. Reload this page after starting Lead Finder.');
  const response = await fetch(path, {
    ...options,
    headers: { 'X-Local-Token': state.token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    cache: 'no-store',
  });
  if (!response.ok) {
    let details;
    try { details = await response.json(); } catch { /* The server may return a non-JSON network error. */ }
    throw new Error(details?.error || `The request failed (${response.status}). Please try again.`);
  }
  return response;
}

async function jsonApi(path, options = {}) {
  return (await api(path, options)).json();
}

function getInput() {
  return {
    linkedinUrl: $('#linkedin-url').value.trim(),
    name: $('#person-name').value.trim(),
    company: $('#company').value.trim(),
    domain: $('#domain').value.trim(),
  };
}

function currentMode() { return form.elements.mode.value; }

function modeLabel(mode) { return { website: 'Website search', public: 'Single page', paste: 'Pasted text' }[mode] || 'Public page'; }

function discoverLabel() {
  return state.submitting ? 'Finding emails…' : { website: 'Search website for emails', public: 'Find published emails', paste: 'Find emails in text' }[currentMode()];
}

function updateMode() {
  const mode = currentMode();
  $('#public-fields').hidden = mode === 'paste';
  $('#paste-fields').hidden = mode !== 'paste';
  $('#source-url').required = mode === 'public';
  $('#source-url').disabled = mode === 'paste';
  $('#source-url-label').replaceChildren(document.createTextNode(mode === 'website' ? 'Website or starting page ' : 'Public page URL'));
  if (mode === 'website') $('#source-url-label').append(element('span', 'optional', 'optional with a company domain'));
  $('#source-url').placeholder = mode === 'website' ? 'https://company.com' : 'https://company.com/team/person';
  $('#source-url-hint').textContent = mode === 'website'
    ? 'Checks up to 5 public pages on the same website, following Contact, About, Team, or relevant staff links it finds. No outside websites, private pages, or LinkedIn.'
    : 'Finds emails already published on this single page. Use a public professional bio, team, or contact page. LinkedIn pages are not fetched.';
  $('#source-text').required = mode === 'paste';
  $('#source-text').disabled = mode !== 'paste';
  $('#paste-source-url').disabled = mode !== 'paste';
  $('#discover-label').textContent = discoverLabel();
  showError('#form-error', '');
}

function updateSearchLinks() {
  const input = getInput();
  const nameQuery = input.name ? `"${input.name}"` : '';
  const query = [nameQuery, input.company || input.domain, 'email contact'].filter(Boolean).join(' ');
  let domain = input.domain.replace(/^https?:\/\//i, '').split('/')[0].trim();
  const domainQuery = [domain ? `site:${domain}` : input.company, nameQuery, 'contact'].filter(Boolean).join(' ');
  $('#search-links').hidden = !input.name && !input.company && !input.domain;
  $('#web-search').href = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  $('#company-search').href = `https://www.google.com/search?q=${encodeURIComponent(domainQuery)}`;
  const profile = safeUrl(input.linkedinUrl);
  const isLinkedIn = profile && (profile.hostname === 'linkedin.com' || profile.hostname.endsWith('.linkedin.com'));
  $('#open-profile').hidden = !isLinkedIn;
  if (isLinkedIn) $('#open-profile').href = profile.href;
}

function jobTitle(job) {
  return job.input?.name || job.input?.company || job.input?.domain || 'Contact research';
}

function upsertJob(job) {
  const index = state.jobs.findIndex(item => item.id === job.id);
  if (index === -1) state.jobs.unshift(job);
  else state.jobs[index] = job;
  state.jobs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function exportable(result) { return result.review === 'approved' && result.deliverability !== 'invalid'; }

function renderStats() {
  const results = state.jobs.flatMap(job => job.results || []);
  $('#stat-searches').textContent = String(state.jobs.length);
  $('#stat-pending').textContent = String(results.filter(result => result.review === 'pending').length);
  $('#stat-approved').textContent = String(new Set(results.filter(exportable).map(result => result.email.toLowerCase())).size);
  // Exports cover the whole workspace, including jobs older than the history limit.
  $('#export-csv').disabled = !state.token;
  $('#export-json').disabled = !state.token;
}

function renderHistory() {
  const list = $('#history-list');
  list.replaceChildren();
  if (!state.jobs.length) {
    list.append(element('p', 'empty-history', 'Your searches will appear here.'));
    return;
  }
  for (const job of state.jobs.slice(0, 25)) {
    const row = button('', `history-item${job.id === state.selectedId ? ' active' : ''}`, () => {
      state.selectedId = job.id;
      renderHistory();
      renderSelectedJob();
    });
    row.setAttribute('aria-pressed', String(job.id === state.selectedId));
    const initials = jobTitle(job).split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    row.append(element('span', 'history-avatar', initials));
    const details = element('span', 'history-details');
    details.append(element('span', 'history-title', jobTitle(job)));
    const count = job.results?.length || 0;
    const status = job.status === 'running' ? 'Searching…' : job.status === 'error' || job.status === 'interrupted' ? statusText(job.status) : `${count} ${count === 1 ? 'email' : 'emails'}`;
    details.append(element('span', 'history-meta', `${modeLabel(job.mode)} · ${status} · ${dateLabel(job.createdAt)}`));
    row.append(details);
    const dot = element('span', `history-dot ${job.status}`);
    dot.setAttribute('aria-hidden', 'true');
    row.append(dot);
    list.append(row);
  }
  if (state.jobs.length > 25) list.append(element('p', 'empty-history', `Showing the 25 most recent searches. Exports include all confirmed contacts.`));
}

function statusText(status) {
  return { running: 'Searching', complete: 'Complete', no_result: 'No email found', error: 'Needs attention', interrupted: 'Interrupted' }[status] || status;
}

function stateMessage({ title, description, icon = '⌕', error = false, loading = false, job }) {
  const wrapper = element('div', `state-message${error ? ' error' : ''}`);
  const visual = element('div', 'state-icon', loading ? undefined : icon);
  if (loading) visual.append(element('span', 'spinner'));
  visual.setAttribute('aria-hidden', 'true');
  wrapper.append(visual, element('h3', '', title), element('p', '', description));
  if (loading) wrapper.append(element('p', 'loading-caption', 'Reading the source and keeping a record of any published emails.'));
  if (job && !loading) {
    const canRetry = state.requests.has(job.id) || (job.mode === 'public' && job.sourceUrl) || (job.mode === 'website' && (job.sourceUrl || job.input?.domain));
    wrapper.append(button(canRetry ? 'Retry this search' : 'Use these details', 'button button-outline', () => retryJob(job)));
  }
  return wrapper;
}

function renderSelectedJob() {
  const job = state.jobs.find(item => item.id === state.selectedId);
  content.replaceChildren();
  $('#job-summary').hidden = !job;
  $('#result-count').hidden = !job;
  content.setAttribute('aria-busy', String(job?.status === 'running'));
  if (!job) {
    $('#results-subtitle').textContent = 'Published emails and their sources, together.';
    content.append(originalEmptyState.cloneNode(true));
    return;
  }
  const summary = $('#job-summary');
  summary.replaceChildren();
  const identity = element('div');
  identity.append(element('div', 'job-summary-title', jobTitle(job)));
  identity.append(element('div', 'job-summary-meta', [job.input?.company || job.input?.domain, modeLabel(job.mode), dateLabel(job.createdAt, true)].filter(Boolean).join(' · ')));
  summary.append(identity, element('span', `status-label ${job.status}`, statusText(job.status)));
  $('#results-subtitle').textContent = 'Review each source before confirming a person match.';
  $('#result-count').textContent = `${job.results?.length || 0} found`;
  if (job.coverage) content.append(renderCoverage(job.coverage));
  if (job.status === 'running') {
    content.append(stateMessage({ title: job.mode === 'website' ? 'Checking the website…' : 'Following the source…', description: job.mode === 'website' ? 'Reading the starting page and up to 4 linked contact, about, team, or relevant staff pages on the same website.' : 'This search is running locally. You can keep researching while it completes.', loading: true }));
    return;
  }
  if (job.status === 'error' || job.status === 'interrupted') {
    content.append(stateMessage({ title: job.status === 'interrupted' ? 'This search was interrupted.' : 'We couldn’t read this source.', description: job.error || 'The server restarted before this search finished. Try the source again.', icon: '!', error: true, job }));
    return;
  }
  if (!job.results?.length) {
    const website = job.mode === 'website';
    const unread = job.coverage?.pages?.filter(page => ['error', 'blocked'].includes(page.status)).length || 0;
    content.append(stateMessage({
      title: website ? 'No email in the pages read.' : 'No email in this source.',
      description: website
        ? `${unread ? `${unread} ${unread === 1 ? 'page could' : 'pages could'} not be read. ` : ''}This was a limited website search, so other pages may still contain a public email. Review Pages checked, try a more specific starting page, or paste visible public contact information.`
        : 'No readable email address was found in the supplied page or text. Try a public bio or contact page, or paste visible contact information. This does not mean the person has no public email.',
      job,
    }));
    return;
  }
  const list = element('div', 'result-list');
  for (const result of job.results) list.append(renderResult(job, result));
  content.append(list);
}

function renderCoverage(coverage) {
  const pages = coverage.pages || [];
  const unread = pages.filter(page => ['error', 'blocked'].includes(page.status)).length;
  const limited = ['max_pages', 'time_limit'].includes(coverage.stopReason);
  const wrapper = element('details', `coverage${unread || limited ? ' coverage-partial' : ''}`);
  const summary = element('summary', 'coverage-summary');
  summary.append(element('span', '', `Pages checked · ${pages.length}`));
  summary.append(document.createTextNode(' · '));
  if (unread) summary.append(element('span', 'coverage-status', `${unread} not read · partial search`));
  else if (limited) summary.append(element('span', 'coverage-status', coverage.stopReason === 'time_limit' ? 'Time limit reached' : 'Page limit reached'));
  else summary.append(element('span', 'coverage-status', `${pages.filter(page => page.status === 'read').length} read`));
  wrapper.append(summary);
  wrapper.append(element('p', 'coverage-note', `Checks at most ${coverage.maxPages || 5} pages. Only links found on the same website are followed; this is not an exhaustive search.`));
  const list = element('ul', 'coverage-list');
  for (const page of pages) {
    const row = element('li', `coverage-page ${page.status}`);
    const url = safeUrl(page.url);
    if (url) {
      const link = element('a', '', `${url.hostname}${url.pathname === '/' ? '/' : url.pathname} ↗`);
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = url.href;
      row.append(link);
    } else row.append(element('span', '', 'Source URL unavailable'));
    const label = page.status === 'read' ? page.emailCount ? `${page.emailCount} ${page.emailCount === 1 ? 'email' : 'emails'} found` : 'Read · no email found' : page.status === 'duplicate' ? 'Already checked · duplicate URL' : page.status === 'blocked' ? 'Blocked · not read' : 'Error · not read';
    row.append(element('span', 'coverage-page-status', label));
    if (page.observedAt) row.append(element('span', 'coverage-observed', `Observed ${dateLabel(page.observedAt, true)}`));
    if (page.error) row.append(element('p', 'coverage-error', page.error));
    list.append(row);
  }
  wrapper.append(list);
  for (const warning of coverage.warnings || []) wrapper.append(element('p', 'coverage-note', warning));
  return wrapper;
}

function appendTag(parent, text, kind = '') { parent.append(element('span', `tag ${kind}`, text)); }

function renderResult(job, result) {
  const card = element('article', `result-card ${result.review}`);
  const top = element('div', 'result-email-row');
  top.append(element('h3', 'result-email', result.email));
  top.append(button('Copy', 'copy-button', async () => {
    try { await navigator.clipboard.writeText(result.email); toast('Email copied.'); }
    catch { toast('Clipboard access is unavailable. Select the address to copy it.'); }
  }));
  card.append(top);
  const badges = element('div', 'result-badges');
  appendTag(badges, result.sourceType === 'public_page' ? 'Found on a public page' : 'Found in pasted text');
  appendTag(badges, result.deliverability === 'invalid' ? 'Invalid address' : 'Deliverability unknown', result.deliverability === 'invalid' ? 'danger' : 'warning');
  if (result.review === 'approved') appendTag(badges, 'Person match confirmed by you', 'positive');
  else if (result.review === 'suppressed') appendTag(badges, 'Excluded from all exports', 'danger');
  else appendTag(badges, 'Person match needs review', 'warning');
  for (const flag of result.flags || []) appendTag(badges, String(flag).replace(/_/g, ' '), 'warning');
  card.append(badges);
  if (result.context && !result.sources?.some(source => source.context)) card.append(element('p', 'result-context', result.context));
  const sources = element('div', 'source-list');
  sources.append(element('span', 'source-heading', 'SOURCE EVIDENCE'));
  if (!result.sources?.length) sources.append(element('p', 'verification-note', 'Pasted text — no source link supplied. Review the context before confirming.'));
  for (const source of result.sources || []) {
    const entry = element('div', 'source-entry');
    const url = safeUrl(source.url);
    if (url) {
      const link = element('a', '', `${url.hostname}${url.pathname === '/' ? '' : url.pathname} ↗`);
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = url.href;
      entry.append(link);
    } else entry.append(element('span', '', 'Pasted text — source link not supplied'));
    if (source.observedAt) entry.append(element('span', '', `Observed ${dateLabel(source.observedAt, true)}`));
    if (source.lastSeenOn) entry.append(element('span', '', `Source last seen ${dateLabel(source.lastSeenOn)}`));
    if (source.context) entry.append(element('p', 'result-context source-context', source.context));
    sources.append(entry);
  }
  card.append(sources);
  card.append(element('p', 'verification-note', result.review === 'approved' ? 'You confirmed the person match. Deliverability has not been independently verified.' : 'Check that the published address belongs to this person. Extraction alone does not establish ownership or deliverability.'));
  const actions = element('div', 'result-actions');
  if (result.review === 'suppressed') {
    actions.append(element('span', 'result-review-label', 'Suppressed across this workspace'));
  } else if (result.review === 'approved') {
    const approved = element('div', 'approved-actions');
    approved.append(element('span', 'result-review-label', '✓ Person match confirmed'));
    approved.append(button('Undo', 'text-button', () => review(job, result, 'pending', card)));
    actions.append(approved);
  } else {
    const approve = button('Confirm person match', 'button button-primary', () => review(job, result, 'approved', card));
    approve.disabled = !job.input?.name || result.deliverability === 'invalid';
    if (!job.input?.name) approve.title = 'Run this search with a full name before confirming the match.';
    if (result.deliverability === 'invalid') approve.title = 'Invalid addresses cannot be exported.';
    actions.append(approve);
  }
  if (result.review !== 'suppressed') {
    const suppress = button('Exclude from all exports', 'suppress-button', () => review(job, result, 'suppressed', card));
    suppress.title = 'Suppress this email across all searches in this workspace.';
    actions.append(suppress);
  }
  card.append(actions);
  return card;
}

async function review(job, result, value, card) {
  card.querySelectorAll('button').forEach(node => { node.disabled = true; });
  try {
    const response = await jsonApi('/api/review', { method: 'POST', body: JSON.stringify({ jobId: job.id, resultId: result.id, review: value }) });
    upsertJob(response.job);
    if (value === 'suppressed') {
      for (const savedJob of state.jobs) for (const candidate of savedJob.results || []) {
        if (candidate.email.toLowerCase() === result.email.toLowerCase()) candidate.review = 'suppressed';
      }
    }
    renderAll();
    toast(value === 'approved' ? 'Person match confirmed. This contact is ready to export.' : value === 'suppressed' ? 'Address excluded from every export in this workspace.' : 'Match returned to review.');
  } catch (error) {
    renderSelectedJob();
    toast(error.message);
  }
}

function renderAll() { renderStats(); renderHistory(); renderSelectedJob(); }

async function refreshHistory({ selectLatest = false } = {}) {
  const data = await jsonApi('/api/jobs');
  state.jobs = data.jobs || [];
  if (selectLatest && !state.selectedId) state.selectedId = state.jobs[0]?.id || null;
  renderAll();
}

async function submitRequest(request) {
  if (state.submitting) return;
  state.submitting = true;
  $('#discover-button').disabled = true;
  updateMode();
  try {
    const data = await jsonApi('/api/discover', { method: 'POST', body: JSON.stringify({ ...request, idempotencyKey: crypto.randomUUID() }) });
    state.requests.set(data.job.id, request);
    upsertJob(data.job);
    state.selectedId = data.job.id;
    renderAll();
    if (window.matchMedia('(max-width: 800px)').matches) $('#results-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { showError('#form-error', error.message); }
  finally {
    state.submitting = false;
    $('#discover-button').disabled = false;
    $('#discover-label').textContent = discoverLabel();
  }
}

function retryJob(job) {
  let request = state.requests.get(job.id);
  if (!request && job.mode === 'public' && job.sourceUrl) request = { mode: 'public', input: job.input, sourceUrl: job.sourceUrl, sourceText: '' };
  if (!request && job.mode === 'website' && (job.sourceUrl || job.input?.domain)) request = { mode: 'website', input: job.input, sourceUrl: job.sourceUrl || '', sourceText: '' };
  if (request) { submitRequest({ ...request, retry: true }); return; }
  $('#person-name').value = job.input?.name || '';
  $('#company').value = job.input?.company || '';
  $('#domain').value = job.input?.domain || '';
  $('#linkedin-url').value = job.input?.linkedinUrl || '';
  form.elements.mode.value = ['website', 'public', 'paste'].includes(job.mode) ? job.mode : 'public';
  $('#source-url').value = job.mode === 'paste' ? '' : job.sourceUrl || '';
  if (job.mode === 'paste') {
    $('#source-text').value = '';
    $('#paste-source-url').value = job.sourceUrl || '';
  }
  updateMode();
  updateSearchLinks();
  const field = job.mode === 'paste' ? $('#source-text') : $('#source-url');
  field.focus();
  toast('Add the source again. Full pasted text is not saved in your search history.');
}

async function exportContacts(format) {
  const control = $(`#export-${format}`);
  control.disabled = true;
  try {
    const response = await api(`/api/export?format=${format}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = `lead-finder-contacts-${new Date().toISOString().slice(0, 10)}.${format}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Export downloaded. Includes confirmed contacts, with source evidence.');
  } catch (error) { toast(error.message); }
  finally { control.disabled = false; }
}

async function pollRunningJobs() {
  if (state.polling || !state.token) return;
  const running = state.jobs.filter(job => job.status === 'running');
  if (!running.length) return;
  state.polling = true;
  try {
    const updates = await Promise.all(running.map(job => jsonApi(`/api/jobs/${encodeURIComponent(job.id)}`)));
    for (const response of updates) upsertJob(response.job);
    showError('#connection-error', '');
    renderAll();
  } catch (error) { showError('#connection-error', `Could not update search status: ${error.message}`); }
  finally { state.polling = false; }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  const input = getInput();
  if (!input.name) {
    showError('#form-error', 'Add the person’s full name so you can review and confirm the email match.');
    $('#person-name').focus();
    return;
  }
  const mode = currentMode();
  const sourceUrl = (mode === 'paste' ? $('#paste-source-url') : $('#source-url')).value.trim();
  if (mode === 'website' && !sourceUrl && !input.domain) {
    showError('#form-error', 'Add the company domain or a public starting page to search this website.');
    $('#domain').focus();
    return;
  }
  submitRequest({ mode, input, sourceUrl, sourceText: mode === 'paste' ? $('#source-text').value : '' });
});
form.querySelectorAll('input[name=mode]').forEach(node => node.addEventListener('change', updateMode));
for (const id of ['#linkedin-url', '#person-name', '#company', '#domain']) $(id).addEventListener('input', updateSearchLinks);
$('#refresh-history').addEventListener('click', async () => {
  $('#refresh-history').disabled = true;
  try { await refreshHistory(); toast('Search history refreshed.'); }
  catch (error) { toast(error.message); }
  finally { $('#refresh-history').disabled = false; }
});
$('#export-csv').addEventListener('click', () => exportContacts('csv'));
$('#export-json').addEventListener('click', () => exportContacts('json'));

async function initialize() {
  const params = new URLSearchParams(window.location.search);
  for (const [param, id] of [['linkedinUrl', '#linkedin-url'], ['name', '#person-name'], ['company', '#company'], ['domain', '#domain']]) {
    if (params.has(param)) $(id).value = params.get(param);
  }
  if (params.has('sourceUrl')) $('#source-url').value = params.get('sourceUrl');
  if (params.has('linkedinUrl')) $('.profile-reference').open = true;
  updateMode();
  updateSearchLinks();
  $('#discover-button').disabled = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('The local server is not responding.');
    const status = await response.json();
    if (!status.token) throw new Error('The local server did not provide a session token.');
    state.token = status.token;
    await refreshHistory({ selectLatest: true });
    $('#discover-button').disabled = false;
    setInterval(pollRunningJobs, 1500);
  } catch (error) {
    showError('#connection-error', `${error.message} Start the Lead Finder server, then reload this page.`);
  }
}

initialize();
