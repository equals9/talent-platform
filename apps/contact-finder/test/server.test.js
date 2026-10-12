import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.js';

const fixture = (overrides = {}) => ({
  id: 'public-email-1',
  email: 'alex@example.test',
  sourceType: 'public_page',
  deliverability: 'unknown',
  flags: [],
  context: 'Alex Example, public company contact',
  sources: [{ url: 'https://example.test/team', observedAt: '2026-10-11T12:00:00.000Z' }],
  ...overrides,
});

const input = (overrides = {}) => ({
  mode: 'paste',
  input: { name: 'Alex Example', company: 'Example', linkedinUrl: 'https://www.linkedin.com/in/alex-example' },
  sourceUrl: 'https://example.test/team',
  sourceText: 'Alex Example: alex@example.test',
  idempotencyKey: 'request-one',
  ...overrides,
});

async function harness(t, discovery = async () => [fixture()]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'lead-finder-http-test-'));
  let app;
  let port;
  let token;
  async function open() {
    app = createApp({ dataDir, discovery });
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    port = app.server.address().port;
    token = (await request('/api/status', { auth: false })).json.token;
  }
  function request(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1', port, path, method,
        headers: {
          ...(auth ? { 'X-Local-Token': token } : {}),
          ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }),
          ...headers,
        },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text, json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject);
      req.end(encoded);
    });
  }
  async function finished(id) {
    const deadline = Date.now() + 900;
    do {
      const response = await request(`/api/jobs/${id}`);
      assert.equal(response.status, 200);
      if (response.json.job.status !== 'running') return response.json.job;
      await delay(5);
    } while (Date.now() < deadline);
    assert.fail(`Search ${id} did not finish within 900ms`);
  }
  async function search(args = input()) {
    const response = await request('/api/discover', { method: 'POST', body: args });
    assert.ok([200, 202].includes(response.status), response.text);
    return finished(response.json.job.id);
  }
  const review = (job, status = 'approved') => request('/api/review', {
    method: 'POST', body: { jobId: job.id, resultId: job.results[0].id, review: status },
  });
  t.after(async () => {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await open();
  return {
    request, finished, search, review,
    reopen: async () => { await app.close(); app = undefined; await open(); },
  };
}

test('local API requires a session token and rejects foreign origins, cross-site requests and rebinding', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/api/jobs', { auth: false })).status, 403);
  assert.equal((await h.request('/api/jobs', { headers: { 'X-Local-Token': 'wrong-token' } })).status, 403);
  assert.equal((await h.request('/api/jobs', { headers: { 'X-Local-Token': 'é'.repeat(64) } })).status, 403);
  for (const path of ['/api/status', '/api/jobs']) {
    for (const headers of [
      { Origin: 'https://foreign.example.test' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { Host: 'rebind.example.test' },
    ]) assert.equal((await h.request(path, { headers })).status, 403, JSON.stringify({ path, headers }));
  }
  const status = await h.request('/api/status', { auth: false });
  assert.equal(status.status, 200);
  assert.equal(status.json.mode, 'public_sources_only');
  assert.match(status.json.token, /^[a-f0-9]{64}$/);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.match(status.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('paid provider configuration and lookup routes do not exist', async t => {
  const h = await harness(t);
  for (const path of ['/api/provider', '/api/providers', '/api/hunter', '/api/settings', '/api/enrich']) {
    assert.equal((await h.request(path)).status, 404, path);
    assert.equal((await h.request(path, { method: 'POST', body: {} })).status, 404, path);
  }
});

test('website mode accepts a domain and persists coverage without weakening review or suppression', async t => {
  let received;
  const coverage = { startedFrom: 'https://clinic.org/', maxPages: 5, stopReason: 'finished', warnings: [], pages: [{ url: 'https://clinic.org/contact', status: 'read', emailCount: 1, observedAt: '2026-10-11T12:00:00Z' }] };
  const h = await harness(t, async args => { received = args; return { results: [fixture()], coverage }; });
  const args = input({ mode: 'website', input: { name: 'Alex Example', domain: 'clinic.org' }, sourceUrl: '', sourceText: '' });
  const job = await h.search(args);
  assert.equal(received.sourceUrl, 'https://clinic.org/');
  assert.equal(job.sourceUrl, 'https://clinic.org/');
  assert.deepEqual(job.coverage, coverage);
  assert.equal(job.results[0].deliverability, 'unknown');
  assert.equal(job.results[0].review, 'pending');
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
  await h.reopen();
  assert.deepEqual((await h.request(`/api/jobs/${job.id}`)).json.job.coverage, coverage);
  assert.equal((await h.review(job, 'suppressed')).status, 200);
  const again = await h.search({ ...args, idempotencyKey: 'website-retry', retry: true });
  assert.equal(again.results[0].review, 'suppressed');
  assert.equal((await h.review(again)).status, 409);
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
  const invalid = await h.request('/api/discover', { method: 'POST', body: { ...args, sourceUrl: 'https://clinic.org/?action=delete', idempotencyKey: 'bad-query' } });
  assert.equal(invalid.status, 400);
});

test('a website blocked before reading any pages is an error, not a no-email finding', async t => {
  const h = await harness(t, async () => ({ results: [], coverage: { pages: [{ url: 'https://clinic.org/', status: 'blocked', error: 'robots.txt excludes this path' }] } }));
  const job = await h.search(input({ mode: 'website', sourceUrl: 'https://clinic.org/', sourceText: '' }));
  assert.equal(job.status, 'error');
  assert.match(job.error, /No pages could be read/);
  assert.equal(job.coverage.pages[0].status, 'blocked');
});

test('unreviewed results cannot export; approval records ownership without asserting deliverability', async t => {
  const h = await harness(t);
  const job = await h.search();
  assert.equal(job.status, 'complete');
  assert.equal(job.results[0].review, 'pending');
  let exported = await h.request('/api/export?format=json');
  assert.equal(exported.json.count, 0);
  assert.deepEqual(exported.json.contacts, []);
  assert.equal((await h.review(job)).status, 200);
  exported = await h.request('/api/export?format=json');
  assert.equal(exported.json.count, 1);
  assert.equal(exported.json.contacts[0].ownership, 'user_confirmed_match');
  assert.equal(exported.json.contacts[0].deliverability, 'unknown');
  assert.equal(exported.json.contacts[0].email, 'alex@example.test');
  assert.equal(exported.json.contacts[0].source_urls, 'https://example.test/team');
  assert.ok(exported.json.contacts[0].reviewed_at);
  assert.equal((await h.review(job, 'pending')).status, 200);
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
});

test('approval requires a person name', async t => {
  const h = await harness(t);
  const job = await h.search(input({ input: { name: '   ', company: 'Example' } }));
  const rejected = await h.review(job);
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.error, /name/i);
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
});

test('suppression applies globally to duplicate and future discoveries and survives reopening', async t => {
  let invocation = 0;
  const h = await harness(t, async () => [fixture({ email: invocation++ % 2 ? 'ALEX@example.test' : 'alex@example.test' })]);
  const first = await h.search();
  const duplicate = await h.search(input({ idempotencyKey: 'second', sourceText: 'Another source: alex@example.test' }));
  assert.equal((await h.review(first)).status, 200);
  assert.equal((await h.review(duplicate)).status, 200);
  assert.equal((await h.request('/api/export?format=json')).json.count, 1, 'case insensitive export deduplication');
  assert.equal((await h.review(first, 'suppressed')).status, 200);
  assert.equal((await h.request(`/api/jobs/${duplicate.id}`)).json.job.results[0].review, 'suppressed');
  assert.equal((await h.review(duplicate)).status, 409);
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
  await h.reopen();
  assert.equal((await h.request(`/api/jobs/${first.id}`)).json.job.results[0].review, 'suppressed');
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
  const future = await h.search(input({ idempotencyKey: 'third', sourceText: 'Future source: alex@example.test' }));
  assert.equal(future.results[0].review, 'suppressed');
  assert.equal((await h.review(future)).status, 409);
});

test('identical input coalesces and conflicting reuse of a request ID returns 409', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; return [fixture()]; });
  const first = await h.search();
  for (const idempotencyKey of ['request-one', 'different-key']) {
    const response = await h.request('/api/discover', { method: 'POST', body: input({ idempotencyKey }) });
    assert.equal(response.status, 200);
    assert.equal(response.json.cached, true);
    assert.equal(response.json.job.id, first.id);
  }
  assert.equal(calls, 1);
  const conflict = await h.request('/api/discover', { method: 'POST', body: input({ sourceText: 'Changed source content' }) });
  assert.equal(conflict.status, 409);
  assert.equal(calls, 1);
});

test('a coalesced request ID remains reserved against later conflicting inputs after reopening', async t => {
  const h = await harness(t);
  await h.search();
  assert.equal((await h.request('/api/discover', { method: 'POST', body: input({ idempotencyKey: 'alias-key' }) })).status, 200);
  await h.reopen();
  const conflict = await h.request('/api/discover', {
    method: 'POST', body: input({ idempotencyKey: 'alias-key', sourceText: 'Different source text' }),
  });
  assert.equal(conflict.status, 409);
});

test('approved contacts and idempotency persist after the server reopens', async t => {
  let calls = 0;
  const h = await harness(t, async () => { calls++; return [fixture()]; });
  const job = await h.search();
  assert.equal((await h.review(job)).status, 200);
  await h.reopen();
  const jobs = await h.request('/api/jobs');
  assert.equal(jobs.json.jobs.length, 1);
  assert.equal(jobs.json.jobs[0].id, job.id);
  assert.equal(jobs.json.jobs[0].results[0].review, 'approved');
  assert.equal((await h.request('/api/export?format=json')).json.count, 1);
  const repeated = await h.search();
  assert.equal(repeated.id, job.id);
  assert.equal(calls, 1);
});

test('no result and source errors remain distinct terminal states without fabricated contacts', async t => {
  const h = await harness(t, async args => {
    if (args.sourceText === 'source failure') throw Object.assign(new Error('private technical detail'), { publicMessage: 'The public source could not be read.' });
    return [];
  });
  const empty = await h.search();
  assert.equal(empty.status, 'no_result');
  assert.deepEqual(empty.results, []);
  assert.equal(empty.error, null);
  const failed = await h.search(input({ idempotencyKey: 'error-key', sourceText: 'source failure' }));
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.results, []);
  assert.equal(failed.error, 'The public source could not be read.');
  assert.equal((await h.request('/api/status')).json.activeSearches, 0);
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
});

test('invalid addresses cannot export even after review', async t => {
  const h = await harness(t, async () => [fixture({ deliverability: 'invalid' })]);
  const job = await h.search();
  assert.equal((await h.review(job)).status, 200);
  assert.equal((await h.request('/api/export?format=json')).json.count, 0);
});

test('CSV export neutralizes spreadsheet formulas and quotes embedded delimiters', async t => {
  const h = await harness(t, async () => [fixture({ context: '@SUM(1,2)', flags: ['\t=1+1'] })]);
  const job = await h.search(input({ input: { name: '=2+2', company: '+SUM(1,2), "Example"' } }));
  assert.equal((await h.review(job)).status, 200);
  const exported = await h.request('/api/export');
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-type'], /^text\/csv/);
  assert.match(exported.headers['content-disposition'], /attachment/);
  assert.ok(exported.text.startsWith('\uFEFF'));
  assert.ok(exported.text.includes('"\'=2+2"'));
  assert.ok(exported.text.includes('"\'+SUM(1,2), ""Example"""'));
  assert.ok(exported.text.includes('"\'@SUM(1,2)"'));
  assert.ok(exported.text.includes('"\'\t=1+1"'));
});
