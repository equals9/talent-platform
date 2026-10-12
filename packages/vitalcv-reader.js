import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { isPublicIp } from '../apps/contact-finder/discovery.js';

export const VITALCV_ORIGIN = 'https://api.vitalcv.com';
const MAX_BYTES = 256 * 1024;
const CLAIM_TYPES = ['NPI_IDENTITY', 'SPECIALTY', 'LICENSE', 'NURSING_LICENSE', 'BOARD_CERTIFICATION', 'EXCLUSION_STATUS', 'ENROLLMENT_STATUS'];
const PUBLIC_SOURCES = new Set(['NPPES_API', 'OIG_LEIE', 'SAM_GOV', 'PECOS_PUBLIC', 'STATE_BOARD']);
const VALUE_FIELDS = {
  NPI_IDENTITY: ['npi', 'status', 'credential', 'lastUpdated', 'enumerationDate', 'enumerationType'],
  SPECIALTY: ['taxonomyCode', 'taxonomyDescription', 'isPrimary', 'state'],
  LICENSE: ['state', 'source', 'issueDate', 'expiryDate', 'licenseNumber', 'licenseStatus'],
  NURSING_LICENSE: ['state', 'source', 'issueDate', 'expiryDate', 'licenseStatus'],
  BOARD_CERTIFICATION: ['specialty', 'board', 'status', 'certificationDate', 'expiresAt'],
  EXCLUSION_STATUS: ['source', 'verdict', 'excluded', 'matchType', 'dataVersion', 'dataFreshness', 'sourceLatency', 'matchConfidence', 'leieVersionDate'],
  ENROLLMENT_STATUS: ['source', 'enrolled', 'claimState', 'observedAt', 'dataVersion', 'dataFreshness', 'sourceLatency', 'statusLabel', 'sourceDisclaimer'],
};
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function redactText(value) {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
    try {
      const url = new URL(raw);
      url.username = ''; url.password = '';
      for (const key of [...url.searchParams.keys()]) if (/token|secret|password|api.?key|authorization/i.test(key)) url.searchParams.delete(key);
      return url.href;
    } catch { return '[invalid source link]'; }
  });
}
const text = (value, max = 800) => typeof value === 'string' ? redactText(value.slice(0, max)) : null;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const stamp = () => new Date().toISOString();

export function validateVitalCvNpi(value) {
  if (typeof value !== 'string' || !/^[12]\d{9}$/.test(value)) throw failure('NPI must be a 10-digit provider identifier.');
  const digits = `80840${value}`.split('').map(Number);
  const sum = digits.reverse().reduce((total, digit, index) => {
    const doubled = index % 2 ? digit * 2 : digit;
    return total + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  if (sum % 10) throw failure('NPI has an invalid check digit.');
  return value;
}

function fixedUrl(path, origin) {
  if (origin !== VITALCV_ORIGIN) throw failure('VitalCV reads use the configured official API origin only.');
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password || url.hash) throw failure('The VitalCV endpoint must stay on the configured API.');
  const allowed = /^\/api\/identity\/[12]\d{9}(?:\/claims)?$/.test(url.pathname)
    || ['/health', '/api/version', '/api/system/source-runtime'].includes(url.pathname);
  if (!allowed) throw failure('This endpoint is outside the VitalCV read contract.');
  for (const key of url.searchParams.keys()) {
    if (!['view', 'depth', 'limit', 'type'].includes(key)) throw failure('Unsupported VitalCV query parameter.');
  }
  if (url.pathname.startsWith('/api/identity/')) {
    validateVitalCvNpi(url.pathname.split('/')[3]);
    const entries = [...url.searchParams.keys()];
    if (entries.length !== new Set(entries).size) throw failure('Repeated VitalCV query parameters are blocked.');
    if (url.pathname.endsWith('/claims')) {
      if (entries.length !== 2 || !CLAIM_TYPES.includes(url.searchParams.get('type')) || url.searchParams.get('limit') !== '10') throw failure('Unsupported VitalCV claim query.');
    } else if (entries.length !== 3 || url.searchParams.get('view') !== 'mobile' || url.searchParams.get('depth') !== '0' || url.searchParams.get('limit') !== '1') throw failure('Unsupported VitalCV identity query.');
  } else if (url.search) throw failure('Query parameters are not supported for VitalCV service probes.');
  return url;
}

function beforeDeadline(promise, deadline) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure('VitalCV did not respond within the read time limit.', 504)), Math.max(1, deadline - Date.now()));
  })]).finally(() => clearTimeout(timer));
}

// TLS still authenticates api.vitalcv.com. DNS answers are checked together and
// the connection uses one checked answer; redirects, credentials and cookies
// are never followed or sent.
export async function requestVitalCvJson(path, { origin = VITALCV_ORIGIN, timeoutMs = 8000, lookupImpl = dnsLookup, requestImpl = https.request } = {}) {
  const url = fixedUrl(path, origin);
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 8000, 1), 10000);
  const addresses = await beforeDeadline(lookupImpl(url.hostname, { all: true, verbatim: true }), deadline);
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64
    || addresses.some(row => !isPublicIp(row.address) || isIP(row.address) !== row.family)) {
    throw failure('VitalCV DNS resolved to a private or unsupported address.', 502);
  }
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    let settled = false, request, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { request?.destroy(); reject(error); } else resolve(value);
    };
    const lookup = (_hostname, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family);
    try {
      request = requestImpl(url, { method: 'GET', agent: false, family: address.family, lookup,
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'TalentPlatform/0.2 (selected-provider public evidence read)' } }, response => {
        const status = response.statusCode;
        if (!status || status < 200 || status >= 300) {
          response.destroy();
          return finish(failure(status >= 300 && status < 400 ? 'VitalCV redirected the read; redirects are blocked.' : `VitalCV returned HTTP ${status || 'error'}.`, status || 502));
        }
        if (!/^application\/json(?:\s*;|$)/i.test(String(response.headers['content-type'] || ''))) {
          response.destroy(); return finish(failure('VitalCV returned an unsupported response type.', 502));
        }
        if ((response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') || Number(response.headers['content-length']) > MAX_BYTES) {
          response.destroy(); return finish(failure('VitalCV response exceeds the bounded JSON read contract.', 502));
        }
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) { response.destroy(); finish(failure('VitalCV response exceeds the bounded JSON read contract.', 502)); } else chunks.push(chunk); });
        response.on('end', () => {
          try { const json = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!record(json)) throw new Error(); finish(null, json); }
          catch { finish(failure('VitalCV returned invalid JSON.', 502)); }
        });
        response.on('error', () => finish(failure('VitalCV response ended before the read completed.', 502)));
        response.on('aborted', () => finish(failure('VitalCV response ended before the read completed.', 502)));
      });
      request.on('error', () => finish(failure('The VitalCV API connection could not be established securely.', 502)));
      timer = setTimeout(() => finish(failure('VitalCV did not respond within the read time limit.', 504)), Math.max(1, deadline - Date.now()));
      request.end();
    } catch { finish(failure('The VitalCV API connection could not be established securely.', 502)); }
  });
}

function selectedValue(type, input) {
  if (!record(input)) return {};
  return Object.fromEntries(VALUE_FIELDS[type].filter(key => Object.hasOwn(input, key)).flatMap(key => {
    const value = input[key];
    return value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string'
      ? [[key, typeof value === 'string' ? text(value, 1600) : value]] : [];
  }));
}

function normalizeClaim(claim, type, npi, sourceUrl, readAt) {
  if (!record(claim) || claim.claimType !== type || typeof claim.claimId !== 'string' || typeof claim.sourceId !== 'string') return null;
  const value = selectedValue(type, claim.value);
  if (type === 'NPI_IDENTITY' && value.npi !== npi) return null;
  const reviewRequired = claim.reviewRequired !== false;
  const disclaimer = value.sourceDisclaimer || '';
  const demonstration = /simulat|preview|synthetic|demo|placeholder/i.test(disclaimer) || /seed|mock|demo/i.test(claim.sourceId);
  const sourceAllowed = PUBLIC_SOURCES.has(claim.sourceId);
  // An unavailable licensed connector is useful negative evidence. Actual
  // partner-only credential results are withheld under public-sources-only.
  const negativePartner = claim.sourceId === 'NURSYS' && value.licenseStatus === 'UNKNOWN';
  if (!sourceAllowed && !negativePartner && !demonstration) return null;
  const sourceObservedAt = timestamp(claim.observedAt);
  const validUntil = timestamp(claim.validUntil);
  const expiry = timestamp(value.expiryDate ?? value.expiresAt);
  const expired = [validUntil, expiry].filter(Boolean).some(date => Date.parse(date) <= Date.parse(readAt));
  const limitations = ['Observed upstream normalized claim; no issuer signature, receipt or scoped acceptance has been checked.'];
  if (reviewRequired) limitations.push(text(claim.reviewReason) || 'Upstream requires review.');
  if (demonstration) limitations.push('Upstream explicitly describes preview or simulated data; this cannot support qualification.');
  if (disclaimer) limitations.push(disclaimer);
  if (negativePartner) limitations.push('Licensed connector output is unavailable; no partner credential result is imported.');
  if (expired) limitations.push('The upstream validity or expiry deadline has passed.');
  if (!validUntil && !expiry) limitations.push('No claim expiry or validity deadline was supplied; current freshness remains unknown.');
  return {
    type, value, sourceId: text(claim.sourceId, 120), sourceUrl, claimId: text(claim.claimId, 160), artifactId: text(claim.artifactId, 160), parserVersion: text(claim.parserVersion, 100),
    sourceObservedAt, derivedAt: timestamp(claim.derivedAt), observedAt: readAt,
    upstreamStatus: text(claim.status, 80), tier: text(claim.tier, 40), confidence: text(claim.confidence, 40), confidenceScore: typeof claim.confidenceScore === 'number' ? claim.confidenceScore : null,
    reviewRequired, reviewReason: text(claim.reviewReason), state: demonstration ? 'demonstration_only' : reviewRequired || negativePartner ? 'review_required' : 'upstream_observation', credentialAssociation: 'upstream_identity', qualificationState: 'unknown',
    freshness: { sourceObservedAt, validUntil, expiresAt: expiry, ageDays: sourceObservedAt ? Math.max(0, (Date.parse(readAt) - Date.parse(sourceObservedAt)) / 86400000) : null,
      state: expired ? 'expired' : validUntil || expiry ? 'deadline_not_passed' : 'unknown' },
    verification: { sourceCheck: 'observed_upstream_claim', receiptCandidate: 'not_assessed', scopedAcceptance: 'not_assessed', revocation: /REVOKED|SUSPENDED/.test(String(value.licenseStatus ?? claim.status)) ? 'reported_by_upstream' : 'not_assessed', decisionGrade: false },
    quote: JSON.stringify(value), quoteKind: 'structured_claim', limitations,
  };
}

export async function readVitalCvProviderEvidence({ npi }, { origin = VITALCV_ORIGIN, readJson = requestVitalCvJson, now = stamp } = {}) {
  validateVitalCvNpi(npi);
  fixedUrl('/health', origin);
  const observedAt = now();
  const deadline = Date.now() + 30000;
  const coverage = [], facts = [];
  const read = async path => {
    const sourceUrl = fixedUrl(path, origin).href;
    try {
      if (Date.now() >= deadline) throw failure('VitalCV provider read time limit was reached.', 504);
      const data = await beforeDeadline(readJson(path, { origin, timeoutMs: Math.min(8000, deadline - Date.now()) }), deadline);
      if (!record(data)) throw failure('VitalCV returned invalid JSON.', 502);
      coverage.push({ sourceUrl, observedAt: now(), status: 'read' }); return data;
    } catch (error) {
      coverage.push({ sourceUrl, observedAt: now(), status: error.status === 404 ? 'no_record' : 'error', httpStatus: error.status || null, error: error.status ? error.message : 'VitalCV read failed.' }); return null;
    }
  };
  const [health, version, identity] = await Promise.all([
    read('/health'), read('/api/version'), read(`/api/identity/${npi}?view=mobile&depth=0&limit=1`),
  ]);
  const limitations = ['Public VitalCV service observations do not establish identity binding, current licensure, hiring eligibility or email ownership.', 'No acquisition, ingestion, issuer-receipt creation or upstream write was requested.', 'Only one selected NPI and declared qualification claim types were read; addresses and protected-characteristic fields are excluded.'];
  let subject = { npi, name: null, credential: null };
  const subjectValid = identity?.npi === npi && identity.schema === 'https://vitalcv.com/mobile/identity/v1';
  if (identity && !subjectValid) limitations.push('VitalCV identity response did not match the requested provider/schema; no claims were accepted.');
  if (subjectValid && record(identity.identity)) subject = { npi, name: text(identity.identity.fullName, 300), credential: text(identity.identity.credential, 100) };
  if (subjectValid && identity.status !== 'NOT_INGESTED') {
    for (const type of CLAIM_TYPES) {
      const path = `/api/identity/${npi}/claims?type=${type}&limit=10`;
      const data = await read(path);
      if (!data) continue;
      if (data.npi !== npi || !Array.isArray(data.claims) || data.claims.length > 10 || data.seedMarker || data.filters?.type !== type) {
        limitations.push(`Rejected ${type} response because its subject, filter or bounded claim schema did not match.`); continue;
      }
      const normalized = data.claims.map(row => normalizeClaim(row, type, npi, fixedUrl(path, origin).href, observedAt)).filter(Boolean);
      facts.push(...normalized);
      if (normalized.some(row => ['LICENSE', 'NURSING_LICENSE'].includes(type) && row.upstreamStatus === 'ACTIVE' && row.value.licenseStatus === 'UNKNOWN')) {
        limitations.push(`${type}: the upstream claim record is ACTIVE while its licenseStatus is UNKNOWN. ACTIVE describes the stored record and is not an active-license verdict.`);
      }
      if (normalized.length < data.claims.length) limitations.push(`Some ${type} rows were withheld because their source, subject or field contract was unsupported.`);
      if (data.nextCursor || Number(data.total) > data.claims.length) limitations.push(`${type} history is partial: at most 10 selected-NPI claims were read; no history pagination was performed.`);
    }
  }
  const sourceData = await read('/api/system/source-runtime');
  const sourceIds = new Set(facts.map(fact => fact.sourceId));
  const sources = Array.isArray(sourceData?.sources) ? sourceData.sources.filter(row => record(row) && sourceIds.has(row.sourceId)).map(row => ({
    sourceId: text(row.sourceId, 120), runtimeState: text(row.runtimeState, 100), isLive: typeof row.isLive === 'boolean' ? row.isLive : null,
    freshnessStatus: text(row.freshnessStatus, 100), lastSuccessfulAt: timestamp(row.lastSuccessfulAt), computedAt: timestamp(row.computedAt ?? sourceData.computedAt), limitation: text(row.limitation),
    decisionGradeEligible: false, upstreamDecisionGradeEligible: typeof row.decisionGradeEligible === 'boolean' ? row.decisionGradeEligible : null,
  })) : [];
  if (!sourceData) limitations.push('Source runtime health was unavailable; source freshness was not qualified.');
  const errors = coverage.some(row => row.status === 'error');
  return {
    schema: 'talent-platform.vitalcv-evidence.v1', projectId: 'vitalcv', status: !subjectValid ? 'unavailable' : identity.status === 'NOT_INGESTED' ? 'no_record' : errors ? 'partial' : 'observed',
    observedAt, subject, facts, sources, coverage, limitations,
    service: { origin, status: text(health?.status, 80) || 'unknown', gitSha: text(version?.commitHash ?? health?.git_sha, 80), version: text(version?.buildVersion, 80), sourceParity: 'not_assessed' },
    credentialAssociation: 'upstream_identity', qualificationState: 'unknown',
    verification: { identityBinding: 'unreviewed', sourceCheck: facts.length ? 'observed_upstream_claims' : 'not_observed', receiptCandidate: 'not_assessed', scopedAcceptance: 'not_assessed', revocation: 'not_assessed', decisionGrade: false },
  };
}

export async function probeVitalCvStatus({ origin = VITALCV_ORIGIN, readJson = requestVitalCvJson, now = stamp } = {}) {
  fixedUrl('/health', origin);
  const observedAt = now(), coverage = [];
  const read = async path => {
    try {
      const data = await readJson(path, { origin });
      if (!record(data)) throw failure('Invalid VitalCV service response.', 502);
      coverage.push({ sourceUrl: fixedUrl(path, origin).href, observedAt: now(), status: 'read' });
      return data;
    } catch (error) {
      coverage.push({ sourceUrl: fixedUrl(path, origin).href, observedAt: now(), status: 'error', httpStatus: error.status || null });
      return null;
    }
  };
  const [health, version, runtime] = await Promise.all([read('/health'), read('/api/version'), read('/api/system/source-runtime')]);
  return {
    projectId: 'vitalcv', status: health?.status === 'ok' && Array.isArray(runtime?.sources) ? 'online' : health ? 'degraded' : 'offline', origin, observedAt,
    apiReachable: Array.isArray(runtime?.sources),
    service: { status: text(health?.status, 80) || 'unknown', gitSha: text(version?.commitHash ?? health?.git_sha, 80), version: text(version?.buildVersion, 80), sourceParity: 'not_assessed' },
    coverage, limitations: ['VitalCV service/API availability does not qualify any selected provider credential.', 'Deployment provenance is observed; local-source parity is not assessed.'],
  };
}
