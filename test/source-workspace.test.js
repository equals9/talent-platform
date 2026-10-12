import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlatform } from '../server.js';

const PERSON = '12345678-1234-1234-1234-123456789abc';
const OTHER = '87654321-4321-4321-4321-cba987654321';
const PROFILE = 'https://professional.example.test/people/alex';
const SOURCE = 'https://professional.example.test/people/alex/contact';
const EMAIL = 'alex@professional.example.test';
const OBSERVED = '2026-10-11T12:00:00.000Z';
function document(id = PERSON) {
  return { person: { id, name: 'Synthetic Provider', npi: '1003000126', company: 'Synthetic Medical Group', profileUrls: [PROFILE] },
    evidence: [{ id: `evidence-${id}`, url: SOURCE, current: true, sourceType: 'provider_directory', quote: `Contact: ${EMAIL}`, observedAt: OBSERVED }],
    contacts: [{ id: `contact-${id}`, value: EMAIL, type: 'email', status: 'observed', evidenceSupported: true, evidenceId: `evidence-${id}`, sourceUrl: SOURCE, quote: `Contact: ${EMAIL}`, observedAt: OBSERVED }],
    limits: { truncated: false }, sourceVersion: 'synthetic-test-v1', warnings: [] };
}
function fixture() {
  const state = { doc: document(), exclusions: [], offline: false, vitalNpi: null, calls: [] };
  const trace = (method, data) => { state.calls.push({ method, data }); };
  const sources = {
    configured: { candidateOS: true, talentos: true, vitalcv: true },
    status: async () => { trace('status'); return { sources: [{ projectId: 'candidate-intelligence-os', status: 'online' }] }; },
    candidatePeople: async query => { trace('candidatePeople', query); return { people: [structuredClone(state.doc.person)] }; },
    candidateEvidence: async id => { trace('candidateEvidence', id); const doc = structuredClone(state.doc); doc.person.id = id; return doc; },
    talentRoles: async options => { trace('talentRoles', options); if (options.limit > 25) throw Object.assign(new Error('Choose a limit from 1 to 25.'), { status: 400 }); return { roles: [{ id: 'upstream-role', title: 'Hospitalist', company: 'Synthetic Medical Group' }] }; },
    talentRole: async id => { trace('talentRole', id); return { role: { id, sourceId: id, title: 'Hospitalist', company: 'Synthetic Medical Group', description: 'Internal medicine evidence required.', criteria: [{ id: 'criterion-1', text: 'Internal medicine', quoteSupport: 'exact_source_quote', authority: 'upstream_derived_criterion' }] }, snapshotHash: 'synthetic-role-hash' }; },
    talentPeople: async () => { trace('talentPeople'); return { candidates: [] }; },
    talentEvidence: async id => { trace('talentEvidence', id); return { candidate: { id, name: 'TalentOS Synthetic', profileUrls: [PROFILE], sources: [{ url: SOURCE }], evidence: [] }, snapshotHash: 'synthetic-person-hash', warnings: [] }; },
    exclusions: async () => { trace('exclusions'); if (state.offline) throw Object.assign(new Error('Exclusion reader offline.'), { status: 503 }); return { suppressions: structuredClone(state.exclusions) }; },
    vitalEvidence: async npi => { trace('vitalEvidence', npi); state.vitalNpi = npi; return { schema: 'talent-platform.vitalcv-evidence.v1', projectId: 'vitalcv', status: 'observed', subject: { npi, name: 'Different upstream display name' }, observedAt: OBSERVED, qualificationState: 'unknown', verification: { decisionGrade: false, scopedAcceptance: 'not_assessed' }, facts: [{ type: 'LICENSE', value: { licenseStatus: 'UNKNOWN' }, reviewRequired: true, qualificationState: 'unknown', sourceUrl: 'https://api.vitalcv.com/api/identity/1003000126/claims?type=LICENSE&limit=10', verification: { decisionGrade: false } }] }; },
  };
  return { sources, state };
}

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'talent-source-workspace-'));
  const feed = fixture();
  let app, port, token;
  const request = (path, { method = 'GET', body, headers = {}, auth = true } = {}) => new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { ...(auth ? { 'X-Local-Token': token } : {}), ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null }); });
    });
    req.on('error', reject); req.end(encoded);
  });
  const discovery = async () => [{ id: 'original-contact', email: EMAIL, deliverability: 'unknown', ownership: 'unreviewed', flags: [], sourceType: 'public_page', context: `Synthetic: ${EMAIL}`, sources: [{ url: SOURCE, observedAt: OBSERVED, context: `Synthetic: ${EMAIL}` }] }];
  const open = async () => {
    app = createPlatform({ dataDir, sources: feed.sources, discovery });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    port = app.server.address().port; token = (await request('/api/status', { auth: false })).json.token;
  };
  await open();
  t.after(async () => { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const post = (path, body, options) => request(path, { method: 'POST', body, ...options });
  const workspace = async () => { const result = await request('/api/workspace'); assert.equal(result.status, 200, result.text); return result.json; };
  const keep = (body = {}) => post('/api/keep-source', { sourceProject: 'candidate-intelligence-os', sourceId: PERSON, ...body });
  const dbCheck = work => { const db = new DatabaseSync(join(dataDir, 'contacts.sqlite')); try { return work(db); } finally { db.close(); } };
  return { ...feed, dataDir, request, post, workspace, keep, dbCheck, reopen: async () => { await app.close(); app = null; await open(); } };
}

test('live source reads and selection APIs are authorized before any reader call', async t => {
  const h = await harness(t); h.state.calls = [];
  for (const path of ['/api/sources/status', '/api/sources/candidate-os/people?q=provider', `/api/sources/candidate-os/people/${PERSON}/evidence`, '/api/sources/talentos/roles', '/api/sources/talentos/people', `/api/candidates/${PERSON}/evidence`]) {
    assert.equal((await h.request(path, { auth: false })).status, 403, path);
    assert.equal((await h.request(path, { headers: { Origin: 'https://foreign.example.test' } })).status, 403, path);
  }
  for (const path of ['/api/keep-source', '/api/import-source-role', `/api/candidates/${PERSON}/vitalcv`]) {
    assert.equal((await h.post(path, {}, { auth: false })).status, 403, path);
    assert.equal((await h.post(path, {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, path);
  }
  assert.equal(h.state.calls.length, 0);
});

test('source read is not Keep; invalid role rolls back and explicit Keep preserves pending contact evidence', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/api/sources/candidate-os/people?q=provider')).status, 200);
  assert.equal((await h.request(`/api/sources/candidate-os/people/${PERSON}/evidence`)).status, 200);
  assert.deepEqual((await h.workspace()).candidates, []);
  assert.equal((await h.keep({ roleId: 'missing-role' })).status, 404);
  assert.deepEqual((await h.workspace()).candidates, []);
  assert.equal(h.dbCheck(db => db.prepare('SELECT count(*) n FROM platform_evidence_snapshots').get().n), 0);
  const role = (await h.post('/api/roles', { title: 'Synthetic recruiting role' })).json.role;
  const kept = await h.keep({ roleId: role.id }); assert.equal(kept.status, 201, kept.text);
  const state = await h.workspace(), candidate = state.candidates[0];
  assert.equal(candidate.sourceId, PERSON);
  assert.equal(candidate.provenance.authority, 'source_observation_requires_review');
  assert.equal(candidate.qualificationState, 'unknown');
  assert.equal(candidate.contacts[0].review, 'pending');
  assert.equal(candidate.contacts[0].deliverability, 'unknown');
  assert.equal(candidate.contacts[0].sources[0].url, SOURCE);
  assert.equal(candidate.contacts[0].sources[0].observedAt, OBSERVED);
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
  assert.equal((await h.request(`/api/pipeline/export?roleId=${role.id}&format=json`)).json.candidates[0].approved_emails, '');
  assert.equal((await h.request('/api/sources/talentos/roles')).status, 200, 'real TalentOS limit contract must be respected');
});

test('source-ID replay does not merge equal names; fresh evidence appends and old snapshots cannot change', async t => {
  const h = await harness(t);
  const first = await h.keep(); assert.equal(first.status, 201, first.text);
  const replay = await h.keep(); assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.candidate.id, first.json.candidate.id);
  assert.equal(replay.json.snapshot.id, first.json.snapshot.id);
  const oldSnapshot = structuredClone(first.json.snapshot);
  h.state.doc.evidence[0].quote = `New public observation: ${EMAIL}`;
  h.state.doc.evidence[0].observedAt = '2026-10-12T00:00:00.000Z';
  const refreshed = await h.keep(); assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.json.snapshot.id, first.json.snapshot.id);
  const allEvidence = (await h.request(`/api/candidates/${first.json.candidate.id}/evidence`)).json;
  assert.equal(allEvidence.snapshots.length, 2);
  assert.deepEqual(allEvidence.snapshots.find(row => row.id === oldSnapshot.id), oldSnapshot);
  const other = await h.keep({ sourceId: OTHER }); assert.equal(other.status, 201);
  assert.notEqual(other.json.candidate.id, first.json.candidate.id);
  h.dbCheck(db => {
    assert.throws(() => db.prepare('UPDATE platform_evidence_snapshots SET document=? WHERE id=?').run('{}', oldSnapshot.id), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM platform_evidence_snapshots WHERE id=?').run(oldSnapshot.id), /immutable/);
  });
  await h.reopen();
  const state = await h.workspace();
  assert.equal(state.candidates.length, 2);
  assert.equal(state.candidates.find(row => row.id === first.json.candidate.id).evidenceSnapshotIds.length, 2);
});

test('unsupported or retracted contact observations remain non-exportable', async t => {
  const h = await harness(t);
  h.state.doc.contacts.push({ ...h.state.doc.contacts[0], id: 'guessed', value: 'guessed@professional.example.test', status: 'inferred', quote: 'No published address' });
  h.state.doc.evidence[0].retracted = true;
  const kept = await h.keep(); assert.equal(kept.status, 201);
  const candidate = (await h.workspace()).candidates[0];
  assert.deepEqual(candidate.contacts, []);
  assert.deepEqual(kept.json.snapshot.document.contacts, []);
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
});

test('a source contact without a parseable observation time cannot become approvable', async t => {
  const h = await harness(t);
  h.state.doc.contacts[0].observedAt = 'not-an-observation-date';
  const kept = await h.keep(); assert.equal(kept.status, 201, kept.text);
  assert.deepEqual((await h.workspace()).candidates[0].contacts, [], 'an invalid source timestamp is unsupported evidence');
});

test('VitalCV attaches only through exact canonical NPI; unknown evidence never changes identity or qualification', async t => {
  const h = await harness(t);
  const manual = (await h.post('/api/candidates', { name: 'Synthetic Provider', profileUrl: PROFILE })).json.candidate;
  assert.equal((await h.post(`/api/candidates/${manual.id}/vitalcv`, { npi: '1003000126' })).status, 409);
  assert.equal(h.state.vitalNpi, null);
  const kept = (await h.keep()).json.candidate;
  const attached = await h.post(`/api/candidates/${kept.id}/vitalcv`, { npi: '1003000134' }); assert.equal(attached.status, 201, attached.text);
  assert.equal(h.state.vitalNpi, '1003000126');
  assert.equal(attached.json.candidate.name, 'Synthetic Provider');
  assert.equal(attached.json.candidate.qualificationState, 'unknown');
  assert.equal(attached.json.snapshot.document.facts[0].value.licenseStatus, 'UNKNOWN');
  assert.equal(attached.json.snapshot.document.verification.decisionGrade, false);
  h.sources.vitalEvidence = async () => ({ status: 'observed', subject: { npi: '1003000134' }, facts: [] });
  assert.equal((await h.post(`/api/candidates/${kept.id}/vitalcv`, {})).status, 503);
  const detail = (await h.request(`/api/candidates/${kept.id}/evidence`)).json;
  assert.equal(detail.snapshots.length, 2, 'mismatched provider must not append a snapshot');
});

test('TalentOS role import retains reviewed-source criteria and replays without duplication', async t => {
  const h = await harness(t);
  const imported = await h.post('/api/import-source-role', { sourceId: 'upstream-role' }); assert.equal(imported.status, 201, imported.text);
  assert.equal(imported.json.role.criteria[0].authority, 'upstream_derived_criterion');
  assert.equal(imported.json.role.provenance.authority, 'upstream_recruiter_brief_requires_review');
  const replay = await h.post('/api/import-source-role', { sourceId: 'upstream-role' }); assert.equal(replay.status, 200);
  assert.equal(replay.json.role.id, imported.json.role.id);
  assert.equal((await h.workspace()).roles.length, 1);
});

test('changed source-role evidence stays attached as a new snapshot without silently rewriting recruiter criteria', async t => {
  const h = await harness(t);
  const first = await h.post('/api/import-source-role', { sourceId: 'upstream-role' }); assert.equal(first.status, 201);
  const originalDescription = first.json.role.description;
  h.sources.talentRole = async id => ({ role: { id, sourceId: id, title: 'Changed upstream title', description: 'Changed upstream brief', criteria: [{ id: 'changed-criterion', text: 'Changed interpretation' }] }, snapshotHash: 'changed-role-hash' });
  const refreshed = await h.post('/api/import-source-role', { sourceId: 'upstream-role' }); assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.role.id, first.json.role.id);
  assert.equal(refreshed.json.role.description, originalDescription, 'an evidence refresh must not silently overwrite recruiter role facts');
  assert.equal(refreshed.json.role.evidenceSnapshotIds.length, 2, 'new selected role observation must remain linked to its owner');
});

test('an upstream exclusion of the exact old professional source page blocks approval and contact export', async t => {
  const h = await harness(t);
  const started = await h.post('/api/discover', { mode: 'paste', input: { name: 'Synthetic Provider' }, sourceText: `Synthetic: ${EMAIL}`, sourceUrl: PROFILE, idempotencyKey: 'old-professional-profile' });
  assert.equal(started.status, 202, started.text);
  let job;
  for (let i = 0; i < 20; i++) { job = (await h.request(`/api/jobs/${started.json.job.id}`)).json.job; if (job.status !== 'running') break; await delay(5); }
  assert.equal((await h.post('/api/review', { jobId: job.id, resultId: job.results[0].id, review: 'approved' })).status, 200);
  assert.equal((await h.request('/api/export?format=json')).json.count, 1);
  h.state.exclusions.push({ kind: 'profile_url', value: PROFILE, sourceProject: 'talentos', sourceRecordId: 'old-profile-exclusion', createdAt: OBSERVED });
  assert.equal((await h.request('/api/export?format=json')).json.count, 0, 'the excluded original professional page must not export a prior approval');
  assert.equal((await h.post('/api/review', { jobId: job.id, resultId: job.results[0].id, review: 'approved' })).status, 409);
});

test('new upstream email exclusion removes an already-approved old contact and source pipeline export', async t => {
  const h = await harness(t);
  const role = (await h.post('/api/roles', { title: 'Synthetic recruiting role' })).json.role;
  const started = await h.post('/api/discover', { mode: 'paste', input: { name: 'Synthetic Provider', linkedinUrl: 'https://www.linkedin.com/in/synthetic-provider' }, sourceText: `Synthetic: ${EMAIL}`, sourceUrl: SOURCE, idempotencyKey: 'original-local-contact' });
  assert.equal(started.status, 202, started.text);
  let job;
  for (let i = 0; i < 20; i++) { job = (await h.request(`/api/jobs/${started.json.job.id}`)).json.job; if (job.status !== 'running') break; await delay(5); }
  assert.equal((await h.post('/api/review', { jobId: job.id, resultId: job.results[0].id, review: 'approved' })).status, 200);
  assert.equal((await h.post('/api/keep-research', { jobId: job.id, roleId: role.id })).status, 201);
  const kept = (await h.keep({ roleId: role.id })).json.candidate;
  const sourceJob = (await h.request(`/api/jobs/${kept.researchJobIds[0]}`)).json.job;
  assert.equal((await h.post('/api/review', { jobId: sourceJob.id, resultId: sourceJob.results[0].id, review: 'approved' })).status, 200);
  assert.equal((await h.request('/api/export?format=json')).json.count, 1);
  h.state.exclusions.push({ kind: 'email', value: EMAIL.toUpperCase(), sourceProject: 'talentos', sourceRecordId: 'exclusion-1', createdAt: OBSERVED });
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
  assert.equal((await h.post('/api/review', { jobId: job.id, resultId: job.results[0].id, review: 'approved' })).status, 409);
  const exported = (await h.request(`/api/pipeline/export?roleId=${role.id}&format=json`)).json;
  assert.ok(exported.candidates.every(row => row.approved_emails === ''));
  await h.reopen();
  h.state.exclusions = [];
  assert.equal((await h.request('/api/export?format=json')).json.count, 0, 'source exclusion remains sticky after upstream removal');
});

test('profile exclusions block discovery, Keep and pipeline export; offline feed cannot expose prior approvals', async t => {
  const h = await harness(t);
  const role = (await h.post('/api/roles', { title: 'Synthetic recruiting role' })).json.role;
  const kept = (await h.keep({ roleId: role.id })).json.candidate;
  h.state.exclusions.push({ kind: 'profile_url', value: `${PROFILE}/?tracking=source`, sourceProject: 'talentos', sourceRecordId: 'exclusion-profile', createdAt: OBSERVED });
  const search = await h.request('/api/sources/candidate-os/people?q=provider'); assert.equal(search.status, 200, search.text);
  assert.deepEqual(search.json.people, []);
  assert.equal((await h.keep()).status, 409);
  assert.equal((await h.post(`/api/candidates/${kept.id}/vitalcv`, {})).status, 409);
  const pipeline = await h.request(`/api/pipeline/export?roleId=${role.id}&format=json`); assert.equal(pipeline.status, 200);
  assert.deepEqual(pipeline.json.candidates, []);
  h.state.offline = true;
  for (const path of ['/api/export?format=json', '/api/workspace', `/api/pipeline/export?roleId=${role.id}&format=json`, '/api/sources/candidate-os/people?q=provider']) {
    assert.equal((await h.request(path)).status, 503, `fail closed when exclusions cannot refresh: ${path}`);
  }
  assert.equal((await h.keep()).status, 503);
});
