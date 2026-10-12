import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlatform } from '../server.js';

const contact = () => ({ id: 'observation-1', email: 'alex@example.test', sourceType: 'public_page', deliverability: 'unknown', ownership: 'unreviewed', flags: [], context: 'Alex Example: alex@example.test', sources: [{ url: 'https://example.test/team', observedAt: '2026-10-11T12:00:00Z', context: 'Alex Example: alex@example.test' }] });
const searchInput = (overrides = {}) => ({ mode: 'paste', input: { name: 'Alex Example', company: 'Example', linkedinUrl: 'https://www.linkedin.com/in/alex-example' }, sourceUrl: 'https://example.test/team', sourceText: 'Alex Example: alex@example.test', idempotencyKey: 'first-research', ...overrides });

async function harness(t, discovery = async () => [contact()]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'talent-platform-api-'));
  let app, port, token;
  const request = (path, { method = 'GET', body, headers = {}, auth = true } = {}) => new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { ...(auth ? { 'X-Local-Token': token } : {}), ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null }); });
    });
    req.on('error', reject); req.end(encoded);
  });
  const open = async () => {
    app = createPlatform({ dataDir, discovery });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    port = app.server.address().port;
    token = (await request('/api/status', { auth: false })).json.token;
  };
  t.after(async () => { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await open();
  const post = (path, body, options = {}) => request(path, { method: 'POST', body, ...options });
  const workspace = async () => { const response = await request('/api/workspace'); assert.equal(response.status, 200, response.text); return response.json; };
  const search = async (input = searchInput()) => {
    const started = await post('/api/discover', input); assert.ok([200, 202].includes(started.status), started.text);
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const response = await request(`/api/jobs/${started.json.job.id}`); assert.equal(response.status, 200, response.text);
      if (response.json.job.status !== 'running') return response.json.job;
      await delay(5);
    }
    assert.fail('Synthetic discovery did not finish within one second');
  };
  return { request, post, workspace, search, reopen: async () => { await app.close(); app = null; await open(); } };
}

test('all extra APIs require local authorization before hooks can read or mutate', async t => {
  const h = await harness(t);
  for (const path of ['/api/workspace', '/api/projects', '/api/integrations/status', '/api/pipeline/export?roleId=anything&format=json']) {
    assert.equal((await h.request(path, { auth: false })).status, 403, path);
    assert.equal((await h.request(path, { headers: { Origin: 'https://foreign.example.test' } })).status, 403, path);
  }
  for (const path of ['/api/roles', '/api/candidates', '/api/keep-research', '/api/pipeline', '/api/pipeline/stage', '/api/import']) {
    assert.equal((await h.post(path, {}, { auth: false })).status, 403, path);
    assert.equal((await h.post(path, {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, path);
    assert.equal((await h.post(path, {}, { headers: { Host: 'rebound.example.test' } })).status, 403, path);
  }
  const state = await h.workspace();
  for (const field of ['roles', 'candidates', 'memberships', 'events', 'imports']) assert.deepEqual(state[field], []);
});

test('research stays outside pipeline until explicit keep; keeping does not approve contact', async t => {
  const h = await harness(t);
  const created = await h.post('/api/roles', { title: 'Research Engineer', company: 'Example' }); assert.equal(created.status, 201);
  const roleId = created.json.role.id;
  const job = await h.search();
  assert.equal((await h.workspace()).candidates.length, 0);
  const kept = await h.post('/api/keep-research', { jobId: job.id, roleId }); assert.equal(kept.status, 201, kept.text);
  const state = await h.workspace();
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].sourceId, job.id);
  assert.equal(state.candidates[0].provenance.kind, 'contact_research');
  assert.equal(state.candidates[0].contacts[0].review, 'pending');
  assert.equal(state.candidates[0].contacts[0].deliverability, 'unknown');
  assert.deepEqual(state.candidates[0].contacts[0].sources, job.results[0].sources);
  assert.equal(state.memberships[0].stage, 'researched');
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
  const exported = await h.request(`/api/pipeline/export?roleId=${roleId}&format=json`);
  assert.equal(exported.json.candidates[0].approved_emails, '');
  assert.equal(exported.json.candidates[0].deliverability, '');
  const again = await h.post('/api/keep-research', { jobId: job.id, roleId }); assert.equal(again.status, 200);
  assert.equal(again.json.candidate.id, kept.json.candidate.id);
  assert.equal((await h.workspace()).events.filter(event => event.action === 'candidate_kept').length, 1);
});

test('roles, candidates, memberships, stage changes and audit events persist across reopen', async t => {
  const h = await harness(t);
  const role = (await h.post('/api/roles', { title: 'Nurse Practitioner', description: 'Evidence of license required' })).json.role;
  const kept = await h.post('/api/candidates', { name: 'Avery Example', profileUrl: 'https://example.test/profile?token=private#fragment', notes: 'Recruiter supplied note' }); assert.equal(kept.status, 201);
  const candidate = kept.json.candidate;
  assert.equal(candidate.profileUrl, 'https://example.test/profile');
  assert.equal((await h.post('/api/pipeline', { roleId: role.id, candidateId: candidate.id })).status, 201);
  assert.equal((await h.post('/api/pipeline/stage', { roleId: role.id, candidateId: candidate.id, stage: 'shortlisted' })).status, 200);
  assert.equal((await h.post('/api/pipeline/stage', { roleId: role.id, candidateId: candidate.id, stage: 'automatically_hired' })).status, 400);
  await h.reopen();
  const state = await h.workspace();
  assert.equal(state.roles[0].id, role.id);
  assert.equal(state.candidates[0].id, candidate.id);
  assert.equal(state.candidates[0].notes, 'Recruiter supplied note');
  assert.deepEqual(state.candidates[0].contacts, []);
  assert.equal(state.memberships[0].stage, 'shortlisted');
  const stageEvent = state.events.find(event => event.action === 'stage_changed');
  assert.deepEqual(stageEvent.details, { roleId: role.id, previousStage: 'researched', stage: 'shortlisted' });
  assert.equal(stageEvent.actor, 'local_recruiter');
});

test('approval exports unknown deliverability and global exclusion removes future and pipeline contacts', async t => {
  const h = await harness(t);
  const role = (await h.post('/api/roles', { title: 'Engineer' })).json.role;
  const job = await h.search();
  assert.equal((await h.post('/api/keep-research', { jobId: job.id, roleId: role.id })).status, 201);
  const review = status => h.post('/api/review', { jobId: job.id, resultId: job.results[0].id, review: status });
  assert.equal((await review('approved')).status, 200);
  let exported = (await h.request(`/api/pipeline/export?roleId=${role.id}&format=json`)).json.candidates[0];
  assert.equal(exported.approved_emails, 'alex@example.test');
  assert.equal(exported.deliverability, 'unknown');
  assert.equal(exported.source_urls, 'https://example.test/team');
  assert.equal((await h.request('/api/export?format=json')).json.contacts[0].deliverability, 'unknown');
  assert.equal((await review('suppressed')).status, 200);
  assert.equal((await review('approved')).status, 409);
  const next = await h.search(searchInput({ idempotencyKey: 'new-observation', retry: true }));
  assert.notEqual(next.id, job.id);
  assert.equal(next.results[0].review, 'suppressed');
  await h.reopen();
  assert.equal((await h.workspace()).candidates[0].contacts[0].review, 'suppressed');
  exported = (await h.request(`/api/pipeline/export?roleId=${role.id}&format=json`)).json.candidates[0];
  assert.equal(exported.approved_emails, '');
  assert.equal(exported.source_urls, '');
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
});

test('keep with an invalid role rejects before candidate or audit writes', async t => {
  const h = await harness(t);
  const job = await h.search();
  const failed = await h.post('/api/keep-research', { jobId: job.id, roleId: 'missing-role' }); assert.equal(failed.status, 404, failed.text);
  const state = await h.workspace();
  assert.deepEqual(state.candidates, [], 'failed keep must not silently keep a candidate');
  assert.deepEqual(state.memberships, []);
  assert.deepEqual(state.events, [], 'failed keep must not claim a candidate was kept');
});

test('Candidate OS import preview performs no writes; commit is idempotent and metadata emails never export', async t => {
  const h = await harness(t);
  const content = 'person_id,name,current_organization,email,email_status,email_source,pipeline_stage\r\np1,Same Name,Example,hidden@example.test,verified,provider,hired\r\np2,Same Name,Example,other@example.test,verified,provider,offer\r\n';
  const preview = await h.post('/api/import', { format: 'candidate-os-csv', content }); assert.equal(preview.status, 200);
  assert.equal(preview.json.preview.candidates, 2);
  const untouched = await h.workspace();
  assert.deepEqual(untouched.candidates, []); assert.deepEqual(untouched.events, []); assert.deepEqual(untouched.imports, []);
  const first = await h.post('/api/import', { format: 'candidate-os-csv', content, commit: true }); assert.equal(first.status, 201);
  assert.equal(first.json.import.candidatesCreated, 2);
  const replay = await h.post('/api/import', { format: 'candidate-os-csv', content, commit: true }); assert.equal(replay.status, 201);
  assert.equal(replay.json.import.replayed, true);
  const state = await h.workspace();
  assert.equal(state.candidates.length, 2); assert.equal(state.imports.length, 1);
  assert.notEqual(state.candidates[0].id, state.candidates[1].id, 'same name must not merge distinct original IDs');
  assert.deepEqual(state.candidates.map(candidate => candidate.sourceId).sort(), ['p1', 'p2']);
  assert.ok(state.candidates.every(candidate => candidate.contacts.length === 0));
  assert.ok(state.candidates.every(candidate => candidate.provenance.deliverability === 'unknown'));
  assert.deepEqual(state.memberships, []);
  const role = (await h.post('/api/roles', { title: 'Reviewed role' })).json.role;
  for (const candidate of state.candidates) assert.equal((await h.post('/api/pipeline', { roleId: role.id, candidateId: candidate.id })).status, 201);
  const exported = await h.request(`/api/pipeline/export?roleId=${role.id}&format=json`);
  assert.ok(exported.json.candidates.every(row => row.approved_emails === '' && row.deliverability === '' && row.stage === 'researched'));
  assert.ok(!exported.text.includes('hidden@example.test')); assert.ok(!exported.text.includes('other@example.test'));
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
});

test('invalid CSV and malformed TalentOS bundle reject before any import mutations', async t => {
  const h = await harness(t);
  for (const [format, content] of [
    ['candidate-os-csv', 'person_id,name\np1,Valid First\np2,"Unclosed'],
    ['candidate-os-csv', 'person_id,name\np1,Valid First\np2,'],
    ['talentos-bundle', JSON.stringify({ kind: 'talentos.workspace', version: 1, exportedAt: '2026-10-11T12:00:00Z', searches: { good: { facts: { roleTitle: 'Valid role' }, candidates: { c1: { id: 'one', name: 'Valid Candidate' } } }, bad: { facts: { roleTitle: 'Second role' }, candidates: { c2: { id: 'two', name: '' } } } } })],
  ]) {
    const response = await h.post('/api/import', { format, content, commit: true }); assert.equal(response.status, 400, response.text);
    const state = await h.workspace();
    for (const field of ['roles', 'candidates', 'memberships', 'events', 'imports']) assert.deepEqual(state[field], [], field);
  }
});

