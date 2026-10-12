import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readVitalCvProviderEvidence, probeVitalCvStatus, requestVitalCvJson, validateVitalCvNpi, VITALCV_ORIGIN } from '../packages/vitalcv-reader.js';

const NPI = '1003000126', NOW = '2026-10-12T02:00:00.000Z';
const identity = { npi: NPI, schema: 'https://vitalcv.com/mobile/identity/v1', status: 'READY', identity: { fullName: 'Synthetic Provider', credential: 'M.D.', gender: 'withheld', address: 'withheld' } };
function claim(type, value, extra = {}) {
  return { claimId: `claim_${type}`, claimType: type, sourceId: 'NPPES_API', artifactId: 'artifact-id', parserVersion: 'fixture-v1', observedAt: '2026-01-01T00:00:00.000Z', validUntil: null, status: 'ACTIVE', reviewRequired: false, value, ...extra };
}
function fixture({ identityPayload = identity, rows = {}, failPath, mismatch = false } = {}) {
  const calls = [];
  return {
    calls,
    readJson: async path => {
      calls.push(path);
      if (path === failPath) throw Object.assign(new Error('Service failed.'), { status: 503 });
      if (path === '/health') return { status: 'ok', git_sha: 'a'.repeat(40) };
      if (path === '/api/version') return { commitHash: 'a'.repeat(40), buildVersion: 'fixture' };
      if (path === '/api/system/source-runtime') return { computedAt: NOW, sources: [{ sourceId: 'NPPES_API', runtimeState: 'stale', isLive: false, freshnessStatus: 'stale', limitation: 'Artifact is stale.', lastArtifactId: 'must-not-persist', decisionGradeEligible: true }] };
      if (!path.includes('/claims')) return structuredClone(identityPayload);
      const type = new URL(path, VITALCV_ORIGIN).searchParams.get('type');
      return { npi: mismatch ? '1003000134' : NPI, filters: { type }, total: rows[type]?.length || 0, claims: structuredClone(rows[type] || []) };
    },
  };
}

test('selected-provider reads retain source evidence and unknown qualification without copying addresses or credentials', async () => {
  const feed = fixture({ rows: { NPI_IDENTITY: [claim('NPI_IDENTITY', { npi: NPI, status: 'A', credential: 'M.D.', gender: 'private', address: 'private' })], SPECIALTY: [claim('SPECIALTY', { taxonomyDescription: 'Internal Medicine', licenseNumber: 'not-an-authority-license-verdict' })] } });
  const result = await readVitalCvProviderEvidence({ npi: NPI }, { ...feed, now: () => NOW });
  assert.equal(result.status, 'observed');
  assert.equal(result.subject.name, 'Synthetic Provider');
  assert.equal(result.service.gitSha, 'a'.repeat(40));
  assert.equal(result.facts.length, 2);
  assert.equal(result.facts[0].artifactId, 'artifact-id');
  assert.equal(result.facts[0].freshness.state, 'unknown');
  assert.equal(result.facts[0].verification.decisionGrade, false);
  assert.equal(result.facts[0].credentialAssociation, 'upstream_identity');
  assert.equal(result.facts[0].qualificationState, 'unknown');
  assert.equal(result.facts[0].quoteKind, 'structured_claim');
  assert.match(result.facts[0].sourceUrl, /api\.vitalcv\.com\/api\/identity\/1003000126\/claims/);
  assert.deepEqual(result.sources[0].decisionGradeEligible, false);
  assert.equal(result.sources[0].upstreamDecisionGradeEligible, true);
  assert.doesNotMatch(JSON.stringify(result), /"gender"|"address"|lastArtifactId|not-an-authority-license-verdict/);
  assert.ok(feed.calls.every(path => !/ingest|passport|receipt|providers|POST/.test(path)));
});

test('stored ACTIVE does not override unknown license truth or unavailable partner source', async () => {
  const feed = fixture({ rows: {
    LICENSE: [claim('LICENSE', { state: 'CA', licenseStatus: 'UNKNOWN' }, { sourceId: 'STATE_BOARD', reviewRequired: true, reviewReason: 'Board unavailable.' })],
    NURSING_LICENSE: [claim('NURSING_LICENSE', { licenseStatus: 'UNKNOWN', state: 'NATIONAL' }, { sourceId: 'NURSYS', reviewRequired: true, reviewReason: 'Connector not configured.' })],
  } });
  const result = await readVitalCvProviderEvidence({ npi: NPI }, { ...feed, now: () => NOW });
  assert.equal(result.facts[0].value.licenseStatus, 'UNKNOWN');
  assert.equal(result.facts[0].state, 'review_required');
  assert.ok(result.limitations.some(value => /ACTIVE.*UNKNOWN/.test(value)));
  assert.ok(result.facts[1].limitations.some(value => /Licensed connector output is unavailable/.test(value)));
  assert.equal(result.verification.scopedAcceptance, 'not_assessed');
});

test('simulated enrollment is retained as demonstration-only and licensed partner results are withheld', async () => {
  const feed = fixture({ rows: {
    ENROLLMENT_STATUS: [claim('ENROLLMENT_STATUS', { enrolled: true, sourceDisclaimer: 'Simulated for preview via prefix logic; do not treat as decision-grade.' }, { sourceId: 'PECOS_PUBLIC' })],
    BOARD_CERTIFICATION: [claim('BOARD_CERTIFICATION', { specialty: 'Synthetic specialty', status: 'ACTIVE' }, { sourceId: 'ABMS_PARTNER' })],
    NURSING_LICENSE: [claim('NURSING_LICENSE', { licenseStatus: 'ACTIVE' }, { sourceId: 'NURSYS', reviewRequired: true })],
  } });
  const result = await readVitalCvProviderEvidence({ npi: NPI }, { ...feed, now: () => NOW });
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].state, 'demonstration_only');
  assert.equal(result.facts[0].verification.decisionGrade, false);
  assert.equal(result.facts[0].value.enrolled, true);
  assert.ok(result.limitations.some(value => value.includes('withheld')));
});

test('explicit expiry and revocation remain visible without manufacturing acceptance', async () => {
  const feed = fixture({ rows: { LICENSE: [claim('LICENSE', { licenseStatus: 'REVOKED', expiryDate: '2026-01-02T00:00:00.000Z' }, { sourceId: 'STATE_BOARD', status: 'REVOKED', validUntil: '2026-01-03T00:00:00.000Z' })] } });
  const result = await readVitalCvProviderEvidence({ npi: NPI }, { ...feed, now: () => NOW });
  assert.equal(result.facts[0].freshness.state, 'expired');
  assert.equal(result.facts[0].verification.revocation, 'reported_by_upstream');
  assert.equal(result.facts[0].verification.receiptCandidate, 'not_assessed');
});

test('response subject/filter mismatch and seed snapshots cannot become provider evidence', async () => {
  const wrongSubject = fixture({ mismatch: true, rows: { NPI_IDENTITY: [claim('NPI_IDENTITY', { npi: NPI })] } });
  const result = await readVitalCvProviderEvidence({ npi: NPI }, { ...wrongSubject, now: () => NOW });
  assert.equal(result.facts.length, 0);
  assert.ok(result.limitations.some(value => value.includes('Rejected NPI_IDENTITY')));
  const wrongIdentity = fixture({ identityPayload: { ...identity, npi: '1003000134' } });
  const rejected = await readVitalCvProviderEvidence({ npi: NPI }, { ...wrongIdentity, now: () => NOW });
  assert.equal(rejected.status, 'unavailable');
  assert.equal(wrongIdentity.calls.filter(path => path.includes('/claims')).length, 0);
});

test('not-ingested is no_record and partial errors are preserved as errors', async () => {
  const empty = fixture({ identityPayload: { ...identity, status: 'NOT_INGESTED', identity: null } });
  const noRecord = await readVitalCvProviderEvidence({ npi: NPI }, { ...empty, now: () => NOW });
  assert.equal(noRecord.status, 'no_record');
  assert.equal(noRecord.facts.length, 0);
  assert.equal(empty.calls.filter(path => path.includes('/claims')).length, 0);
  const broken = fixture({ failPath: '/api/identity/1003000126/claims?type=LICENSE&limit=10' });
  const partial = await readVitalCvProviderEvidence({ npi: NPI }, { ...broken, now: () => NOW });
  assert.equal(partial.status, 'partial');
  assert.ok(partial.coverage.some(row => row.status === 'error' && row.httpStatus === 503));
});

test('source evidence redacts credential query parameters and arbitrary fields', async () => {
  const feed = fixture({ rows: { LICENSE: [claim('LICENSE', { licenseStatus: 'UNKNOWN', secret: 'must-not-persist' }, { sourceId: 'STATE_BOARD', reviewRequired: true, reviewReason: 'Visit https://mbc.ca.gov/search?token=SECRET&state=CA' })] } });
  const result = await readVitalCvProviderEvidence({ npi: NPI }, { ...feed, now: () => NOW });
  assert.doesNotMatch(JSON.stringify(result), /SECRET|must-not-persist|token=/);
  assert.match(result.facts[0].reviewReason, /state=CA/);
});

test('service probe checks reachable API and deployment provenance separately from provider qualification', async () => {
  const feed = fixture();
  const result = await probeVitalCvStatus({ ...feed, now: () => NOW });
  assert.equal(result.status, 'online');
  assert.equal(result.apiReachable, true);
  assert.equal(result.service.sourceParity, 'not_assessed');
  assert.deepEqual(feed.calls.sort(), ['/api/system/source-runtime', '/api/version', '/health'].sort());
});

test('NPI check digit, arbitrary origins, path injection and secret queries are rejected before DNS', async () => {
  assert.equal(validateVitalCvNpi(NPI), NPI);
  assert.throws(() => validateVitalCvNpi('1003000127'), /check digit/);
  assert.throws(() => validateVitalCvNpi(`${NPI}/../admin`), /10-digit/);
  let lookups = 0;
  const options = { lookupImpl: async () => { lookups++; return []; } };
  await assert.rejects(requestVitalCvJson('/health', { ...options, origin: 'http://127.0.0.1:4000' }), /official API origin/);
  await assert.rejects(requestVitalCvJson('https://api.vitalcv.com.evil.test/health', options), /configured API/);
  await assert.rejects(requestVitalCvJson('/api/identity/1003000126/ingest', options), /read contract/);
  await assert.rejects(requestVitalCvJson('/health?token=secret', options), /Unsupported/);
  await assert.rejects(requestVitalCvJson('/api/identity/1003000126/claims?type=ADDRESS&limit=10', options), /claim query/);
  assert.equal(lookups, 0);
});

function nativeFixture({ status = 200, body = '{"status":"ok"}', headers = {}, respond = true } = {}) {
  const calls = [];
  const requestImpl = (url, options, callback) => {
    calls.push({ url, options });
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      if (!respond) return;
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = status;
        response.headers = { 'content-type': 'application/json', ...headers };
        callback(response);
        if (!response.destroyed) response.end(body);
      });
    };
    return request;
  };
  return { calls, requestImpl, lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }] };
}

test('transport pins a checked DNS answer and sends no authorization or cookies', async () => {
  const network = nativeFixture();
  assert.deepEqual(await requestVitalCvJson('/health', network), { status: 'ok' });
  assert.equal(network.calls[0].options.method, 'GET');
  assert.equal(network.calls[0].options.agent, false);
  assert.equal(network.calls[0].options.headers.Authorization, undefined);
  assert.equal(network.calls[0].options.headers.Cookie, undefined);
  const answer = await new Promise((resolve, reject) => network.calls[0].options.lookup('api.vitalcv.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(answer, { address: '8.8.8.8', family: 4 });
});

test('one private DNS answer blocks every connection and redirects never reach another host', async () => {
  const network = nativeFixture();
  await assert.rejects(requestVitalCvJson('/health', { ...network, lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /private/);
  assert.equal(network.calls.length, 0);
  const redirect = nativeFixture({ status: 302, headers: { location: 'http://127.0.0.1/private' } });
  await assert.rejects(requestVitalCvJson('/health', redirect), /redirects are blocked/);
  assert.equal(redirect.calls.length, 1);
});

test('transport bounds payload, content type, JSON syntax and DNS wait', async () => {
  await assert.rejects(requestVitalCvJson('/health', nativeFixture({ body: 'x'.repeat(256 * 1024 + 1) })), /bounded JSON/);
  await assert.rejects(requestVitalCvJson('/health', nativeFixture({ headers: { 'content-type': 'text/html' } })), /unsupported response type/);
  await assert.rejects(requestVitalCvJson('/health', nativeFixture({ body: 'broken' })), /invalid JSON/);
  await assert.rejects(requestVitalCvJson('/health', { lookupImpl: () => new Promise(() => {}), timeoutMs: 5 }), /read time limit/);
});
