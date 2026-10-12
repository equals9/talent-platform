import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createPlatform } from '../server.js';

const START = 'https://clinical.example.org/people/alex';
const FACULTY = 'https://faculty.example.org/people/alex';
const OTHER = 'https://leadership.example.org/team';
const EMAIL = 'alex@faculty.example.org';
const OBSERVED = '2026-10-12T12:00:00.000Z';
const CONTEXT = `Alex Example, Clinical Faculty. Email: ${EMAIL}`;
const associationEvidence = { kind: 'named_public_block', name: 'Alex Example', quote: CONTEXT, url: FACULTY };

function input(key, supplementalSourceUrls, extra = {}) {
  return { mode: 'website', input: { name: 'Alex Example', company: 'Synthetic Clinical Group' }, sourceUrl: START,
    idempotencyKey: key, ...(supplementalSourceUrls === undefined ? {} : { supplementalSourceUrls }), ...extra };
}

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'talent-supplemental-source-api-'));
  const state = { calls: [], exclusionCalls: 0, suppressions: [], offline: false };
  const sources = { exclusions: async () => {
    state.exclusionCalls++;
    if (state.offline) throw new Error('Synthetic exclusion reader offline.');
    return { suppressions: structuredClone(state.suppressions) };
  } };
  const discovery = async args => {
    state.calls.push(structuredClone(args));
    return [{ id: 'synthetic-public-observation', email: EMAIL, deliverability: 'unknown', ownership: 'unreviewed',
      sourceType: 'public_page', flags: [], context: CONTEXT, associationEvidence: structuredClone(associationEvidence),
      sources: [{ url: FACULTY, observedAt: OBSERVED, context: CONTEXT, contentHash: 'synthetic-content-hash' }] }];
  };
  let app, port, token;
  const request = (path, { method = 'GET', body, auth = true, headers = {} } = {}) => new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
      ...(auth ? { 'X-Local-Token': token } : {}),
      ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text, json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject); req.end(encoded);
  });
  const open = async () => {
    app = createPlatform({ dataDir, sources, discovery });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    port = app.server.address().port;
    token = (await request('/api/status', { auth: false })).json.token;
  };
  await open();
  t.after(async () => { if (app) await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const post = (path, body, options) => request(path, { method: 'POST', body, ...options });
  const search = async body => {
    const started = await post('/api/discover', body);
    assert.ok([200, 202].includes(started.status), started.text);
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await request(`/api/jobs/${started.json.job.id}`);
      assert.equal(response.status, 200, response.text);
      if (response.json.job.status !== 'running') return { job: response.json.job, started };
      await delay(5);
    }
    assert.fail('Synthetic public-source discovery did not complete.');
  };
  const exclude = value => state.suppressions.push({ kind: 'profile_url', value, sourceProject: 'talentos',
    sourceRecordId: 'synthetic-source-exclusion', createdAt: OBSERVED });
  const modelLegacyCandidate = id => {
    const db = new DatabaseSync(join(dataDir, 'contacts.sqlite'));
    try {
      const candidate = JSON.parse(db.prepare('SELECT document FROM platform_candidates WHERE id=?').get(id).document);
      delete candidate.profileUrls;
      db.prepare('UPDATE platform_candidates SET document=? WHERE id=?').run(JSON.stringify(candidate), id);
    } finally { db.close(); }
  };
  return { state, request, post, search, exclude, modelLegacyCandidate, reopen: async () => { await app.close(); app = null; await open(); } };
}

test('the entire supplemental plan is validated before any discovery call or history write', async t => {
  const h = await harness(t);
  const invalid = [
    'https://faculty.example.org/people/alex',
    [null], [{}], [42],
    Array.from({ length: 5 }, (_, i) => `https://faculty.example.org/people/${i}`),
    Array.from({ length: 5 }, () => FACULTY),
    ['not a complete URL'], ['file:///tmp/private'], ['https://user:secret@faculty.example.org/alex'],
    ['http://127.0.0.1/private'], ['http://localhost/private'], ['http://169.254.169.254/latest/meta-data/'],
    ['https://www.linkedin.com/in/alex-example'], ['https://lnkd.in/private'],
    ['https://faculty.example.org/alex?token=private'], ['https://faculty.example.org/alex?access_token=private'],
  ];
  for (let i = 0; i < invalid.length; i++) {
    const response = await h.post('/api/discover', input(`invalid-${i}`, invalid[i]));
    assert.equal(response.status, 400, `unsafe supplemental plan must fail before fetching: ${response.text}`);
  }
  assert.equal(h.state.calls.length, 0);
  assert.deepEqual((await h.request('/api/jobs')).json.jobs, []);
});

test('canonical source duplicates are removed before fingerprinting and cannot expand the selected plan', async t => {
  const h = await harness(t);
  const first = (await h.search(input('canonical-sources', [
    `${FACULTY}#contact`, 'https://FACULTY.example.org:443/people/alex#same-person', `${START}#already-selected`, OTHER,
  ]))).job;
  assert.deepEqual(first.supplementalSourceUrls, [FACULTY, OTHER]);
  assert.deepEqual(h.state.calls[0].supplementalSourceUrls, [FACULTY, OTHER]);
  const replay = await h.post('/api/discover', input('canonical-replay', [FACULTY, OTHER]));
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.job.id, first.id);
  assert.equal(replay.json.cached, true);
  assert.equal(h.state.calls.length, 1);
});

test('all selected URL inputs are checked together and supplemental plans are website-only', async t => {
  const h = await harness(t);
  for (const [index, body] of [
    input('unused', [FACULTY, 'https://user:secret@leadership.example.org/private']),
    input('unused', [FACULTY], { sourceUrl: 'https://www.linkedin.com/in/alex-example' }),
    input('unused', [FACULTY], { sourceUrl: 'http://127.0.0.1/private' }),
    input('unused', [FACULTY], { mode: 'public' }),
    input('unused', [FACULTY], { mode: 'paste', sourceText: CONTEXT }),
  ].entries()) {
    const response = await h.post('/api/discover', { ...body, idempotencyKey: `invalid-whole-plan-${index}` });
    assert.equal(response.status, 400, response.text);
  }
  assert.equal(h.state.calls.length, 0);
  assert.deepEqual((await h.request('/api/jobs')).json.jobs, []);
});

test('selected supplemental URLs, source evidence and unknown pending contacts survive reopen without automatic Keep', async t => {
  const h = await harness(t);
  const { job } = await h.search(input('selected-sources', [FACULTY, OTHER]));
  assert.equal(h.state.calls.length, 1);
  assert.deepEqual(h.state.calls[0].supplementalSourceUrls, [FACULTY, OTHER]);
  assert.deepEqual(job.supplementalSourceUrls, [FACULTY, OTHER]);
  assert.equal(job.results[0].review, 'pending');
  assert.equal(job.results[0].deliverability, 'unknown');
  assert.deepEqual(job.results[0].associationEvidence, associationEvidence);
  assert.deepEqual(job.results[0].sources, [{ url: FACULTY, observedAt: OBSERVED, context: CONTEXT, contentHash: 'synthetic-content-hash' }]);
  assert.deepEqual((await h.request('/api/workspace')).json.candidates, []);
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
  await h.reopen();
  const restored = (await h.request(`/api/jobs/${job.id}`)).json.job;
  assert.deepEqual(restored.supplementalSourceUrls, [FACULTY, OTHER]);
  assert.deepEqual(restored.results, job.results);
});

test('a different supplemental plan cannot borrow an older cached result or reuse its request ID', async t => {
  const h = await harness(t);
  const first = (await h.search(input('plan-first', [FACULTY]))).job;
  const second = (await h.search(input('plan-second', [OTHER]))).job;
  assert.notEqual(second.id, first.id);
  assert.equal(h.state.calls.length, 2);
  const conflict = await h.post('/api/discover', input('plan-first', [OTHER]));
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(h.state.calls.length, 2);
  const replay = await h.post('/api/discover', input('plan-replay', [FACULTY]));
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.job.id, first.id);
  assert.equal(replay.json.cached, true);
  assert.equal(h.state.calls.length, 2);
});

test('an empty supplemental plan preserves the original request fingerprint and stored job shape', async t => {
  const h = await harness(t);
  const first = (await h.search(input('original-plan'))).job;
  assert.equal(Object.hasOwn(first, 'supplementalSourceUrls'), false);
  const empty = await h.post('/api/discover', input('original-plan', []));
  assert.equal(empty.status, 200, empty.text);
  assert.equal(empty.json.job.id, first.id);
  assert.equal(empty.json.cached, true);
  assert.equal(Object.hasOwn(empty.json.job, 'supplementalSourceUrls'), false);
  const duplicate = await h.post('/api/discover', input('original-plan-deduplicated', [`${START}#same-source`]));
  assert.equal(duplicate.status, 200, duplicate.text);
  assert.equal(duplicate.json.job.id, first.id);
  assert.equal(Object.hasOwn(duplicate.json.job, 'supplementalSourceUrls'), false);
  assert.equal(h.state.calls.length, 1);
});

test('an excluded supplemental source blocks the whole plan before discovery and remains sticky', async t => {
  const h = await harness(t);
  h.exclude(FACULTY);
  assert.equal((await h.post('/api/discover', input('excluded-plan', [FACULTY]))).status, 409);
  assert.equal(h.state.calls.length, 0);
  assert.deepEqual((await h.request('/api/jobs')).json.jobs, []);
  h.state.suppressions = [];
  await h.reopen();
  assert.equal((await h.post('/api/discover', input('excluded-plan-after-reopen', [FACULTY]))).status, 409);
  assert.equal(h.state.calls.length, 0);
});

test('a newly excluded supplemental source removes prior approvals and blocks review and Keep', async t => {
  const h = await harness(t);
  const { job } = await h.search(input('later-excluded-plan', [FACULTY]));
  const review = status => h.post('/api/review', { jobId: job.id, resultId: job.results[0].id, review: status });
  assert.equal((await review('approved')).status, 200);
  assert.equal((await h.request('/api/export?format=json')).json.count, 1);
  h.exclude(FACULTY);
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
  assert.equal((await review('approved')).status, 409);
  assert.equal((await h.post('/api/keep-research', { jobId: job.id })).status, 409);
  assert.equal((await h.request(`/api/jobs/${job.id}`)).json.job.results[0].review, 'suppressed');
});

test('the original source URL exclusion still guards jobs without supplemental sources', async t => {
  const h = await harness(t);
  h.exclude(START);
  assert.equal((await h.post('/api/discover', input('excluded-original-plan'))).status, 409);
  assert.equal(h.state.calls.length, 0);
});

test('global email suppression remains sticky across supplemental plans and reopen', async t => {
  const h = await harness(t);
  const first = (await h.search(input('email-first-plan', [FACULTY]))).job;
  const review = status => h.post('/api/review', { jobId: first.id, resultId: first.results[0].id, review: status });
  assert.equal((await review('suppressed')).status, 200);
  const second = (await h.search(input('email-second-plan', [OTHER]))).job;
  assert.equal(second.results[0].review, 'suppressed');
  assert.equal((await h.post('/api/review', { jobId: second.id, resultId: second.results[0].id, review: 'approved' })).status, 409);
  await h.reopen();
  assert.equal((await h.request(`/api/jobs/${second.id}`)).json.job.results[0].review, 'suppressed');
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
});

test('authorization precedes exclusion reads and an unavailable feed blocks supplemental discovery', async t => {
  const h = await harness(t);
  const before = h.state.exclusionCalls;
  assert.equal((await h.post('/api/discover', input('no-token', [FACULTY]), { auth: false })).status, 403);
  assert.equal((await h.post('/api/discover', input('foreign-origin', [FACULTY]), { headers: { Origin: 'https://foreign.example.org' } })).status, 403);
  assert.equal(h.state.exclusionCalls, before);
  assert.equal(h.state.calls.length, 0);
  h.state.offline = true;
  assert.equal((await h.post('/api/discover', input('offline-feed', [FACULTY]))).status, 503);
  assert.equal(h.state.calls.length, 0);
  h.state.offline = false;
  assert.deepEqual((await h.request('/api/jobs')).json.jobs, []);
});

test('a kept prospect inherits actual observed source URLs and a later source exclusion blocks its pipeline export', async t => {
  const h = await harness(t);
  // The fixture observes FACULTY without listing it as an extra seed: exercise
  // actual-source lineage as well as explicit input lineage.
  const { job } = await h.search(input('kept-observed-source'));
  const role = (await h.post('/api/roles', { title: 'Synthetic internal medicine role' })).json.role;
  const kept = await h.post('/api/keep-research', { jobId: job.id, roleId: role.id });
  assert.equal(kept.status, 201);
  assert.ok(kept.json.candidate.profileUrls.includes(FACULTY));
  assert.equal((await h.request(`/api/pipeline/export?roleId=${role.id}&format=json`)).json.count, 1);
  h.exclude(FACULTY);
  const workspace = (await h.request('/api/workspace')).json;
  assert.equal(workspace.candidates[0].excluded, true);
  assert.deepEqual(workspace.candidates[0].contacts, []);
  assert.equal((await h.request(`/api/pipeline/export?roleId=${role.id}&format=json`)).json.count, 0);
  await h.reopen();
  assert.equal((await h.request(`/api/pipeline/export?roleId=${role.id}&format=json`)).json.count, 0);
});

test('historical kept records without supplemental URL fields still inherit research exclusions without a migration', async t => {
  const h = await harness(t);
  const { job } = await h.search(input('historical-kept-source'));
  const role = (await h.post('/api/roles', { title: 'Historical synthetic role' })).json.role;
  const kept = (await h.post('/api/keep-research', { jobId: job.id, roleId: role.id })).json.candidate;
  h.modelLegacyCandidate(kept.id);
  h.exclude(FACULTY);
  assert.equal((await h.request('/api/workspace')).json.candidates[0].excluded, true);
  assert.equal((await h.request(`/api/pipeline/export?roleId=${role.id}&format=json`)).json.count, 0);
  assert.equal((await h.post('/api/pipeline/stage', { candidateId: kept.id, roleId: role.id, stage: 'shortlisted' })).status, 409);
  const second = (await h.post('/api/roles', { title: 'Another synthetic role' })).json.role;
  assert.equal((await h.post('/api/pipeline', { candidateId: kept.id, roleId: second.id })).status, 409);
});
