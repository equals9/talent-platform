import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createTalentOSReader } from './talentos-reader.js';
import { readVitalCvProviderEvidence, probeVitalCvStatus } from './vitalcv-reader.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function readLiveConfig(root) {
  const path = join(root, 'integrations/live-sources.local.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}
export function createLiveSources(config = {}, { fetchImpl = fetch } = {}) {
  let reader;
  if (config.talentos) {
    if (!isAbsolute(config.talentos.databasePath || '')) throw fail('TalentOS requires an operator-configured absolute database path.');
    reader = createTalentOSReader(config.talentos);
  }
  let candidateOrigin;
  if (config.candidateOS) {
    const url = new URL(config.candidateOS.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('Candidate Intelligence reader must use a fixed loopback origin.');
    if (!isAbsolute(config.candidateOS.tokenFile || '')) throw fail('Configure a private absolute reader token file.');
    candidateOrigin = url.origin;
  }
  async function candidateRead(path) {
    if (!candidateOrigin) throw fail('Candidate Intelligence reader is not configured.', 503);
    if (!/^\/(?:health|people(?:\?|\/[0-9a-f-]{36}\/evidence$))/.test(path)) throw fail('Unsupported evidence read.');
    let token;
    try {
      if (statSync(config.candidateOS.tokenFile).mode & 0o077) throw new Error('permissions');
      token = readFileSync(config.candidateOS.tokenFile, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('token');
    } catch { throw fail('The private evidence reader token is unavailable or has unsafe permissions.', 503); }
    let response;
    try {
      response = await fetchImpl(`${candidateOrigin}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw fail(response.status === 404 ? 'No public professional record was found.' : 'The evidence reader could not complete this read.', response.status === 404 ? 404 : 503);
      if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error('type');
      let size = 0; const chunks = [];
      for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('size'); chunks.push(chunk); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('schema');
      return result;
    } catch (error) { if (error.status) throw error; throw fail('Candidate Intelligence evidence reader is unavailable or returned an unsupported response.', 503); }
  }
  const needTalent = () => { if (!reader) throw fail('TalentOS reader is not configured.', 503); return reader; };
  async function candidateHealth() {
    const health = await candidateRead('/health');
    if (health.readOnly !== true || health.sourceSystem !== 'candidate_intelligence_os' || health.ok !== true) throw fail('Candidate Intelligence did not establish the read-only evidence contract.', 502);
    return health;
  }
  return {
    configured: { candidateOS: !!candidateOrigin, talentos: !!reader, vitalcv: config.vitalcv?.enabled === true },
    async status() {
      const read = async (projectId, work) => { try { return { projectId, ...await work() }; } catch { return { projectId, status: 'offline', available: false, limitations: ['Configured reader could not be read.'] }; } };
      return { sources: await Promise.all([
        candidateOrigin ? read('candidate-intelligence-os', async () => ({ ...await candidateHealth(), status: 'online' })) : { projectId: 'candidate-intelligence-os', status: 'not_configured' },
        reader ? read('talentos', () => ({ ...reader.status(), status: 'online' })) : { projectId: 'talentos', status: 'not_configured' },
        config.vitalcv?.enabled === true ? read('vitalcv', probeVitalCvStatus) : { projectId: 'vitalcv', status: 'not_configured' },
      ]) };
    },
    async candidatePeople(query, limit = 25) {
      if (typeof query !== 'string' || query.trim().length < 2 || query.length > 160 || !Number.isInteger(limit) || limit < 1 || limit > 25) throw fail('Use a 2–160 character query and limit 1–25.');
      await candidateHealth();
      const result = await candidateRead(`/people?q=${encodeURIComponent(query.trim())}&limit=${limit}`);
      if (!Array.isArray(result.people) || result.people.length > limit) throw fail('The evidence search response violated its bounded contract.', 502);
      return result;
    },
    async candidateEvidence(id) {
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw fail('Use the original Candidate Intelligence UUID.');
      const health = await candidateHealth();
      const document = await candidateRead(`/people/${id}/evidence`);
      if (document.person?.id !== id || !Array.isArray(document.evidence) || !Array.isArray(document.contacts)) throw fail('Evidence subject/schema mismatch; no record was accepted.', 502);
      return { ...document, sourceVersion: health.sourceVersion, schemaVersion: health.schemaVersion, readOnly: health.readOnly };
    },
    talentRoles(options) { return needTalent().listRoles(options); },
    talentRole(id) { return needTalent().roleDetails(id); },
    talentPeople(options) { return needTalent().listCandidates(options); },
    talentEvidence(id) { return needTalent().candidateDetails(id); },
    exclusions() { return reader ? reader.suppressions() : { suppressions: [] }; },
    vitalEvidence(npi) { if (!config.vitalcv?.enabled) throw fail('VitalCV public reader is not configured.', 503); return readVitalCvProviderEvidence({ npi }); },
  };
}
