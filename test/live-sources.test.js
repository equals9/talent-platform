import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveSources } from '../packages/live-sources.js';

const PERSON = '12345678-1234-1234-1234-123456789abc';
async function harness(t, { mode = 0o600, token = 'a'.repeat(64), response, status = 200, headers, redirect = false } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'talent-live-sources-'));
  const tokenFile = join(folder, 'reader-token');
  await writeFile(tokenFile, token, { mode }); await chmod(tokenFile, mode);
  t.after(() => rm(folder, { recursive: true, force: true }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (redirect) throw new Error('Redirect blocked.');
    const path = new URL(url).pathname;
    const value = path === '/health' ? { ok: true, readOnly: true, sourceSystem: 'candidate_intelligence_os', sourceVersion: 'fixture-v1', schemaVersion: 'fixture-schema' }
      : path === '/people' ? { people: [] } : response || { person: { id: PERSON }, evidence: [], contacts: [] };
    return new Response(JSON.stringify(value), { status, headers: headers || { 'content-type': 'application/json' } });
  };
  const sources = createLiveSources({ candidateOS: { baseUrl: 'http://127.0.0.1:4330', tokenFile } }, { fetchImpl });
  return { sources, calls, tokenFile };
}

test('Candidate Intelligence uses a fixed loopback origin and a private bearer file; HTTP inputs cannot choose destination', async t => {
  const h = await harness(t);
  await h.sources.candidateEvidence(PERSON);
  assert.equal(h.calls[0].url, 'http://127.0.0.1:4330/health');
  assert.equal(h.calls[1].url, `http://127.0.0.1:4330/people/${PERSON}/evidence`);
  assert.equal(h.calls[1].options.method, 'GET');
  assert.equal(h.calls[1].options.redirect, 'error');
  assert.equal(h.calls[1].options.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
  assert.equal(h.calls[1].options.headers.Cookie, undefined);
  for (const baseUrl of ['https://public.example.test', 'http://localhost:4330', 'http://127.0.0.1:4330/path', 'http://127.0.0.1:4330/?token=x', 'http://a:b@127.0.0.1:4330']) {
    assert.throws(() => createLiveSources({ candidateOS: { baseUrl, tokenFile: h.tokenFile } }), /loopback origin/);
  }
});

test('unsafe or missing reader token files fail before any source call', async t => {
  const unsafe = await harness(t, { mode: 0o644 });
  await assert.rejects(unsafe.sources.candidateEvidence(PERSON), /unsafe permissions/);
  assert.equal(unsafe.calls.length, 0);
  const invalid = await harness(t, { token: 'not-a-reader-secret' });
  await assert.rejects(invalid.sources.candidateEvidence(PERSON), /token is unavailable/);
  assert.equal(invalid.calls.length, 0);
  await rm(invalid.tokenFile);
  await assert.rejects(invalid.sources.candidateEvidence(PERSON), /token is unavailable/);
  assert.equal(invalid.calls.length, 0);
});

test('IDs and bounded queries reject injection before a network read; query text is encoded', async t => {
  const h = await harness(t);
  await assert.rejects(h.sources.candidateEvidence(`${PERSON}/../../health`), /UUID/);
  await assert.rejects(h.sources.candidatePeople('', 25), /query/);
  await assert.rejects(h.sources.candidatePeople('provider', 26), /query/);
  assert.equal(h.calls.length, 0);
  await h.sources.candidatePeople('A & token=private', 2);
  assert.equal(h.calls[1].url, 'http://127.0.0.1:4330/people?q=A%20%26%20token%3Dprivate&limit=2');
});

test('subject mismatch, redirect, MIME failure, oversized JSON and source failure stay errors', async t => {
  const wrong = await harness(t, { response: { person: { id: 'another-person' }, evidence: [], contacts: [] } });
  await assert.rejects(wrong.sources.candidateEvidence(PERSON), /subject\/schema mismatch/);
  const redirect = await harness(t, { redirect: true });
  await assert.rejects(redirect.sources.candidateEvidence(PERSON), /unavailable/);
  assert.equal(redirect.calls.length, 1);
  const mime = await harness(t, { headers: { 'content-type': 'text/html' } });
  await assert.rejects(mime.sources.candidateEvidence(PERSON), /unsupported response/);
  const huge = await harness(t, { response: { person: { id: PERSON }, evidence: [], contacts: [], extra: 'x'.repeat(2 * 1024 * 1024) } });
  await assert.rejects(huge.sources.candidateEvidence(PERSON), /unsupported response/);
  const broken = await harness(t, { status: 503 });
  await assert.rejects(broken.sources.candidateEvidence(PERSON), /complete this read/);
});

test('unconfigured sources report their state without hidden paid or external fallback', async () => {
  const sources = createLiveSources();
  const status = await sources.status();
  assert.ok(status.sources.every(source => source.status === 'not_configured'));
  assert.throws(() => sources.vitalEvidence('1003000126'), /not configured/);
  assert.throws(() => sources.talentRole('role'), /not configured/);
  await assert.rejects(sources.candidateEvidence(PERSON), /not configured/);
});
