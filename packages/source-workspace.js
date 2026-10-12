import { randomUUID, createHash } from 'node:crypto';
import { all, get, createCandidate, createRole, attachCandidate, event, string, link } from './workspace.js';
import { requireIncluded, isProfileExcluded, syncSourceExclusions } from './source-policy.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const stamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function atomic(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function setupEvidence(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_evidence_snapshots(id TEXT PRIMARY KEY, source_project TEXT NOT NULL, source_record_id TEXT NOT NULL, digest TEXT UNIQUE NOT NULL, document TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON platform_evidence_snapshots BEGIN SELECT RAISE(ABORT,'Evidence snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON platform_evidence_snapshots BEGIN SELECT RAISE(ABORT,'Evidence snapshots are immutable'); END;`);
}
function saveSnapshot(db, sourceProject, sourceRecordId, document) {
  const digest = hash({ sourceProject, sourceRecordId, document });
  const old = db.prepare('SELECT document FROM platform_evidence_snapshots WHERE digest=?').get(digest);
  if (old) return JSON.parse(old.document);
  const snapshot = { id: randomUUID(), sourceProject, sourceRecordId, digest, selectedAt: stamp(), document, authority: 'selected_upstream_observation', verification: 'not_independently_verified' };
  db.prepare('INSERT INTO platform_evidence_snapshots(id,source_project,source_record_id,digest,document) VALUES(?,?,?,?,?)').run(snapshot.id, sourceProject, sourceRecordId, digest, JSON.stringify(snapshot));
  return snapshot;
}
export function candidateSnapshots(db, candidate) {
  return (candidate.evidenceSnapshotIds || []).map(id => get(db, 'platform_evidence_snapshots', id)).filter(Boolean);
}
export function evidenceLinks(db, candidate) {
  return [...new Set(candidateSnapshots(db, candidate).flatMap(snapshot => {
    const doc = snapshot.document;
    return [...(doc.evidence || []).map(row => row.url || row.sourceUrl), ...(doc.candidate?.sources || []).map(row => row.url), ...(doc.facts || []).map(row => row.sourceUrl)];
  }).filter(Boolean))];
}
function supportedContacts(document) {
  if (document.truncated || document.limits?.truncated) return [];
  return (document.contacts || []).filter(contact => {
    const evidence = document.evidence?.find(row => row.id === contact.evidenceId);
    return contact.type === 'email' && contact.evidenceSupported === true && ['observed','verified'].includes(contact.status)
      && typeof contact.value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.value)
      && typeof contact.quote === 'string' && contact.quote.toLowerCase().includes(contact.value.toLowerCase())
      && evidence && !evidence.retracted && evidence.current !== false && evidence.sourceType !== 'registry'
      && (!Array.isArray(evidence.assertions) || evidence.assertions.some(assertion => assertion.current && !assertion.retracted))
      && contact.sourceUrl === evidence.url && link(contact.sourceUrl) && Number.isFinite(Date.parse(contact.observedAt));
  });
}
function contactJob(db, person, snapshot, contacts) {
  if (!contacts.length) return null;
  const fingerprint = hash({ snapshotId: snapshot.id, contacts });
  const old = db.prepare('SELECT id FROM jobs WHERE fingerprint=?').get(fingerprint);
  if (old) return old.id;
  const id = randomUUID(), at = stamp();
  const job = { id, input: { name: person.name, company: person.company || '', linkedinUrl: person.profileUrl || person.profileUrls?.[0] || '' }, profileUrls: person.profileUrls || [], mode: 'live_evidence', status: 'complete', sourceUrl: contacts[0].sourceUrl, createdAt: at, updatedAt: at, evidenceSnapshotId: snapshot.id,
    results: contacts.map(contact => ({ id: contact.id, email: contact.value, review: 'pending', deliverability: 'unknown', ownership: 'unreviewed', sourceType: 'public_source_evidence', flags: ['source_identity_requires_review'], context: contact.quote, sourceRecordId: contact.id,
      sources: [{ url: contact.sourceUrl, observedAt: contact.observedAt, context: contact.quote, evidenceId: contact.evidenceId, snapshotId: snapshot.id }] })) };
  db.prepare('INSERT INTO jobs(id,request_key,fingerprint,document) VALUES(?,?,?,?)').run(id, `live:${snapshot.id}`, fingerprint, JSON.stringify(job));
  return id;
}
async function selected(sources, sourceProject, sourceId) {
  if (sourceProject === 'candidate-intelligence-os') {
    const doc = await sources.candidateEvidence(sourceId);
    const contacts = supportedContacts(doc);
    return { person: doc.person, document: { person: doc.person, evidence: doc.evidence, contacts, limits: doc.limits, truncated: doc.truncated === true, sourceVersion: doc.sourceVersion, schemaVersion: doc.schemaVersion, readOnly: true, warnings: [...(doc.warnings || []), `${doc.contacts.length - contacts.length} unsupported contact observations withheld; retained contacts still require recruiter review.`] }, contacts };
  }
  if (sourceProject === 'talentos') {
    const doc = await sources.talentEvidence(sourceId);
    return { person: doc.candidate, contacts: [], document: { candidate: doc.candidate, evidence: doc.candidate.evidence, warnings: doc.warnings, snapshotHash: doc.snapshotHash, readOnly: true } };
  }
  throw fail('Choose a supported live candidate source.');
}
export async function liveWorkspaceRoutes(request, response, url, context, sources) {
  const { db, send, bodyJson } = context;
  const path = url.pathname;
  if (path === '/api/sources/status' && request.method === 'GET') return send(response, 200, await sources.status()), true;
  if (path === '/api/sources/candidate-os/people' && request.method === 'GET') {
    const result = await sources.candidatePeople(url.searchParams.get('q'), Number(url.searchParams.get('limit') || 25));
    return send(response, 200, { ...result, people: result.people.filter(person => !isProfileExcluded(db, person)) }), true;
  }
  let match = /^\/api\/sources\/candidate-os\/people\/([^/]+)\/evidence$/.exec(path);
  if (match && request.method === 'GET') { const doc = await sources.candidateEvidence(match[1]); requireIncluded(db, doc.person); return send(response, 200, doc), true; }
  if (path === '/api/sources/talentos/roles' && request.method === 'GET') return send(response, 200, await sources.talentRoles({ limit: 25 })), true;
  match = /^\/api\/sources\/talentos\/roles\/([^/]+)$/.exec(path);
  if (match && request.method === 'GET') return send(response, 200, await sources.talentRole(match[1])), true;
  if (path === '/api/sources/talentos/people' && request.method === 'GET') {
    const result = await sources.talentPeople({ query: url.searchParams.get('query') || '', sourceRoleId: url.searchParams.get('sourceRoleId') || undefined, limit: 25 });
    return send(response, 200, { ...result, candidates: result.candidates.filter(person => !isProfileExcluded(db, person)) }), true;
  }
  match = /^\/api\/sources\/talentos\/people\/([^/]+)\/evidence$/.exec(path);
  if (match && request.method === 'GET') { const doc = await sources.talentEvidence(match[1]); requireIncluded(db, doc.candidate); return send(response, 200, doc), true; }
  if (path === '/api/keep-source' && request.method === 'POST') {
    const input = await bodyJson(request), sourceProject = string(input.sourceProject, 'Source project', 100, true), sourceId = string(input.sourceId, 'Original source ID', 100, true);
    const selection = await selected(sources, sourceProject, sourceId);
    // Refresh again after any remote read, so a newly recorded exclusion wins.
    syncSourceExclusions(db, await sources.exclusions()); requireIncluded(db, selection.person);
    const result = atomic(db, () => {
      if (input.roleId && !get(db, 'platform_roles', input.roleId)) throw fail('Role not found.', 404);
      const snapshot = saveSnapshot(db, sourceProject, sourceId, selection.document);
      const kept = createCandidate(db, { ...selection.person, profileUrl: selection.person.profileUrl || selection.person.profileUrls?.[0] }, { kind: 'live_source_evidence', sourceProject, sourceId, originKey: `${sourceProject === 'talentos' ? 'talentos-live' : sourceProject}:${sourceId}`, authority: 'source_observation_requires_review', deliverability: 'unknown' });
      const candidate = kept.candidate;
      candidate.evidenceSnapshotIds = [...new Set([...(candidate.evidenceSnapshotIds || []), snapshot.id])];
      candidate.profileUrls = [...new Set([...(candidate.profileUrls || []), ...(selection.person.profileUrls || []), candidate.profileUrl].filter(Boolean))];
      candidate.title ||= selection.person.title || '';
      if (sourceProject === 'candidate-intelligence-os' && selection.person.npi) {
        if (candidate.npi && candidate.npi !== selection.person.npi) throw fail('Canonical NPI changed; resolve identity in the original source before attaching credentials.', 409);
        candidate.npi = selection.person.npi;
      }
      candidate.qualificationState = 'unknown';
      const jobId = contactJob(db, candidate, snapshot, selection.contacts);
      if (jobId) candidate.researchJobIds = [...new Set([...(candidate.researchJobIds || []), jobId])];
      db.prepare('UPDATE platform_candidates SET document=? WHERE id=?').run(JSON.stringify(candidate), candidate.id);
      if (input.roleId) attachCandidate(db, { roleId: input.roleId, candidateId: candidate.id });
      return { ...kept, candidate, snapshot };
    });
    return send(response, result.reused ? 200 : 201, result), true;
  }
  if (path === '/api/import-source-role' && request.method === 'POST') {
    const input = await bodyJson(request), sourceId = string(input.sourceId, 'Source role ID', 100, true);
    const doc = await sources.talentRole(sourceId);
    const result = atomic(db, () => {
      const snapshot = saveSnapshot(db, 'talentos', `role:${sourceId}`, { role: doc.role, snapshotHash: doc.snapshotHash });
      let role = all(db, 'platform_roles').find(role => role.provenance?.originKey === `talentos-live:${sourceId}`);
      if (role) {
        role.evidenceSnapshotIds = [...new Set([...(role.evidenceSnapshotIds || []), snapshot.id])];
        db.prepare('UPDATE platform_roles SET document=? WHERE id=?').run(JSON.stringify(role), role.id);
        return { role, reused: true };
      }
      role = createRole(db, doc.role);
      role.provenance = { kind: 'live_role_snapshot', sourceProject: 'talentos', sourceId, originKey: `talentos-live:${sourceId}`, snapshotId: snapshot.id, authority: 'upstream_recruiter_brief_requires_review' };
      role.criteria = doc.role.criteria; role.evidenceSnapshotIds = [snapshot.id];
      db.prepare('UPDATE platform_roles SET document=? WHERE id=?').run(JSON.stringify(role), role.id);
      return { role, reused: false };
    });
    return send(response, result.reused ? 200 : 201, result), true;
  }
  match = /^\/api\/candidates\/([^/]+)\/(evidence|vitalcv)$/.exec(path);
  if (match) {
    const candidate = get(db, 'platform_candidates', match[1]);
    if (!candidate) throw fail('Candidate not found.', 404);
    if (match[2] === 'evidence' && request.method === 'GET') return send(response, 200, { candidate: { ...candidate, excluded: isProfileExcluded(db, candidate) }, snapshots: candidateSnapshots(db, candidate) }), true;
    if (match[2] === 'vitalcv' && request.method === 'POST') {
      requireIncluded(db, candidate);
      if (!candidate.npi || candidate.sourceProject !== 'candidate-intelligence-os') throw fail('This candidate needs an exact canonical public NPI from Candidate Intelligence before reading VitalCV. No name matching is performed.', 409);
      const doc = await sources.vitalEvidence(candidate.npi);
      if (doc.subject?.npi !== candidate.npi || !['observed','partial','no_record'].includes(doc.status)) throw fail('VitalCV could not provide evidence for this exact NPI; no snapshot was attached.', 503);
      syncSourceExclusions(db, await sources.exclusions()); requireIncluded(db, candidate);
      const snapshot = atomic(db, () => {
        const saved = saveSnapshot(db, 'vitalcv', candidate.npi, doc);
        candidate.evidenceSnapshotIds = [...new Set([...(candidate.evidenceSnapshotIds || []), saved.id])];
        db.prepare('UPDATE platform_candidates SET document=? WHERE id=?').run(JSON.stringify(candidate), candidate.id);
        event(db, candidate.id, 'credential_observation_attached', { snapshotId: saved.id, npi: candidate.npi, qualificationState: 'unknown' });
        return saved;
      });
      return send(response, 201, { candidate, snapshot }), true;
    }
  }
  return false;
}
