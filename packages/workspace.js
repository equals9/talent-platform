import { randomUUID } from 'node:crypto';
import { csvCell } from '../apps/contact-finder/server.js';
import { requireIncluded, isProfileExcluded, setupSourcePolicy } from './source-policy.js';
import { evidenceLinks } from './source-workspace.js';

const stamp = () => new Date().toISOString();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const STAGES = ['researched', 'shortlisted', 'contacted', 'interviewing', 'offer', 'hired', 'closed'];

export function string(value, label, max = 300, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max) throw fail(`${label} must be text up to ${max} characters.`);
  const result = value.trim();
  if (required && !result) throw fail(`${label} is required.`);
  return result;
}

export function link(value) {
  const raw = string(value, 'Profile URL', 2000);
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw fail('Use a complete public profile URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fail('Profile links must use HTTP(S) without credentials.');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/token|secret|password|api.?key|authorization/i.test(key)) url.searchParams.delete(key);
  return url.href;
}

export function setupWorkspace(db) {
  setupSourcePolicy(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_roles(id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_candidates(id TEXT PRIMARY KEY, origin_key TEXT UNIQUE, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_memberships(role_id TEXT NOT NULL, candidate_id TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(role_id,candidate_id));
    CREATE TABLE IF NOT EXISTS platform_events(id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_imports(id TEXT PRIMARY KEY, document TEXT NOT NULL);
  `);
}

function atomic(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function all(db, table) { return db.prepare(`SELECT document FROM ${table} ORDER BY rowid DESC`).all().map(row => JSON.parse(row.document)); }
export function get(db, table, id) { const row = db.prepare(`SELECT document FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(row.document) : null; }
export function event(db, entityId, action, details) {
  const item = { id: randomUUID(), entityId, action, details, at: stamp(), actor: 'local_recruiter' };
  db.prepare('INSERT INTO platform_events(id,entity_id,document) VALUES(?,?,?)').run(item.id, entityId, JSON.stringify(item));
  return item;
}

export function createRole(db, input) {
  const role = { id: randomUUID(), title: string(input.title, 'Role title', 300, true), company: string(input.company, 'Company'), location: string(input.location, 'Location'), description: string(input.description, 'Role brief', 20000), status: 'open', createdAt: stamp() };
  db.prepare('INSERT INTO platform_roles(id,document) VALUES(?,?)').run(role.id, JSON.stringify(role));
  event(db, role.id, 'role_created', { title: role.title });
  return role;
}

export function createCandidate(db, input, provenance = null) {
  requireIncluded(db, input);
  const candidate = {
    id: randomUUID(), name: string(input.name, 'Candidate name', 300, true), company: string(input.company, 'Company'), location: string(input.location, 'Location'), profileUrl: link(input.profileUrl),
    notes: string(input.notes, 'Recruiter notes', 10000), sourceProject: provenance?.sourceProject || 'recruiter', sourceId: provenance?.sourceId || null,
    provenance: provenance || { kind: 'recruiter_record', assertedAt: stamp(), authority: 'recruiter_supplied' }, createdAt: stamp()
  };
  const originKey = provenance?.originKey || null;
  if (originKey) {
    const old = db.prepare('SELECT document FROM platform_candidates WHERE origin_key=?').get(originKey);
    if (old) return { candidate: JSON.parse(old.document), reused: true };
  }
  db.prepare('INSERT INTO platform_candidates(id,origin_key,document) VALUES(?,?,?)').run(candidate.id, originKey, JSON.stringify(candidate));
  event(db, candidate.id, 'candidate_kept', { sourceProject: candidate.sourceProject, sourceId: candidate.sourceId });
  return { candidate, reused: false };
}

export function attachCandidate(db, { roleId, candidateId }) {
  roleId = string(roleId, 'Role ID', 100, true);
  candidateId = string(candidateId, 'Candidate ID', 100, true);
  if (!get(db, 'platform_roles', roleId)) throw fail('Role not found.', 404);
  if (!get(db, 'platform_candidates', candidateId)) throw fail('Candidate not found.', 404);
  requireIncluded(db, get(db, 'platform_candidates', candidateId));
  const old = db.prepare('SELECT document FROM platform_memberships WHERE role_id=? AND candidate_id=?').get(roleId, candidateId);
  if (old) return JSON.parse(old.document);
  const membership = { roleId, candidateId, stage: 'researched', createdAt: stamp(), updatedAt: stamp() };
  db.prepare('INSERT INTO platform_memberships(role_id,candidate_id,document) VALUES(?,?,?)').run(roleId, candidateId, JSON.stringify(membership));
  event(db, candidateId, 'added_to_role', { roleId, stage: 'researched' });
  return membership;
}

export function changeStage(db, { roleId, candidateId, stage }) {
  roleId = string(roleId, 'Role ID', 100, true);
  candidateId = string(candidateId, 'Candidate ID', 100, true);
  if (!STAGES.includes(stage)) throw fail('Choose a supported pipeline stage.');
  requireIncluded(db, get(db, 'platform_candidates', candidateId) || {});
  const row = db.prepare('SELECT document FROM platform_memberships WHERE role_id=? AND candidate_id=?').get(roleId, candidateId);
  if (!row) throw fail('This candidate is not in that role.', 404);
  const membership = JSON.parse(row.document);
  if (membership.stage === stage) return membership;
  const previousStage = membership.stage;
  membership.stage = stage; membership.updatedAt = stamp();
  db.prepare('UPDATE platform_memberships SET document=? WHERE role_id=? AND candidate_id=?').run(JSON.stringify(membership), roleId, candidateId);
  event(db, candidateId, 'stage_changed', { roleId, previousStage, stage });
  return membership;
}

export function contactsForCandidate(db, candidate, context) {
  if (isProfileExcluded(db, candidate)) return [];
  const ids = [...new Set([...(candidate.researchJobIds || []), ...(candidate.provenance?.kind === 'contact_research' ? [candidate.sourceId] : [])])];
  // Keeping a prospect is independent from confirming any address on its source pages.
  return ids.flatMap(id => (context.getJob(id)?.results || []).map(result => ({ ...result, jobId: id })));
}

export async function workspaceRoutes(request, response, url, context) {
  const { db, send, bodyJson } = context;
  if (url.pathname === '/api/workspace' && request.method === 'GET') {
    const candidates = all(db, 'platform_candidates').map(candidate => ({ ...candidate, excluded: isProfileExcluded(db, candidate), contacts: contactsForCandidate(db, candidate, context) }));
    return send(response, 200, { roles: all(db, 'platform_roles'), candidates, memberships: all(db, 'platform_memberships'), events: all(db, 'platform_events').slice(0, 300), imports: all(db, 'platform_imports'), stages: STAGES, mode: 'public_sources_only' }), true;
  }
  if (url.pathname === '/api/roles' && request.method === 'POST') {
    const input = await bodyJson(request);
    const role = atomic(db, () => createRole(db, input)); return send(response, 201, { role }), true;
  }
  if (url.pathname === '/api/candidates' && request.method === 'POST') {
    const input = await bodyJson(request);
    const result = atomic(db, () => createCandidate(db, input)); return send(response, 201, result), true;
  }
  if (url.pathname === '/api/keep-research' && request.method === 'POST') {
    const input = await bodyJson(request);
    const job = context.getJob(string(input.jobId, 'Research ID', 100, true));
    if (!job) throw fail('Research search not found.', 404);
    if (job.status === 'running') throw fail('Wait for the research to finish before keeping this prospect.');
    const result = atomic(db, () => {
      const kept = createCandidate(db, { ...job.input, profileUrl: job.input.linkedinUrl || job.sourceUrl }, { kind: 'contact_research', sourceProject: 'lead-finder', sourceId: job.id, originKey: `lead-finder:${job.id}`, observedAt: job.updatedAt, authority: 'source_observation_requires_review' });
      if (input.roleId) attachCandidate(db, { roleId: input.roleId, candidateId: kept.candidate.id });
      return kept;
    });
    return send(response, result.reused ? 200 : 201, result), true;
  }
  if (url.pathname === '/api/pipeline' && request.method === 'POST') {
    const input = await bodyJson(request);
    const membership = atomic(db, () => attachCandidate(db, input)); return send(response, 201, { membership }), true;
  }
  if (url.pathname === '/api/pipeline/stage' && request.method === 'POST') {
    const input = await bodyJson(request);
    const membership = atomic(db, () => changeStage(db, input)); return send(response, 200, { membership }), true;
  }
  if (url.pathname === '/api/pipeline/export' && request.method === 'GET') {
    const roleId = string(url.searchParams.get('roleId'), 'Role ID', 100, true);
    if (!get(db, 'platform_roles', roleId)) throw fail('Role not found.', 404);
    const memberships = all(db, 'platform_memberships').filter(item => item.roleId === roleId);
    const rows = memberships.filter(membership => !isProfileExcluded(db, get(db, 'platform_candidates', membership.candidateId))).map(membership => {
      const candidate = get(db, 'platform_candidates', membership.candidateId);
      const approved = contactsForCandidate(db, candidate, context).filter(contact => contact.review === 'approved' && contact.deliverability !== 'invalid' && !context.isSuppressed(contact.email));
      return { name: candidate.name, company: candidate.company, stage: membership.stage, profile_url: candidate.profileUrl, source_project: candidate.sourceProject, source_id: candidate.sourceId, approved_emails: approved.map(contact => contact.email).join(' | '), deliverability: approved.length ? 'unknown' : '', source_urls: [...new Set([...approved.flatMap(contact => contact.sources.map(source => source.url).filter(Boolean)), ...evidenceLinks(db, candidate)])].join(' | '), evidence_snapshot_ids: (candidate.evidenceSnapshotIds || []).join(' | '), qualification_state: candidate.qualificationState || 'unknown', notes: candidate.notes };
    });
    if (url.searchParams.get('format') === 'json') return send(response, 200, { count: rows.length, candidates: rows }), true;
    const columns = ['name', 'company', 'stage', 'profile_url', 'source_project', 'source_id', 'approved_emails', 'deliverability', 'source_urls', 'evidence_snapshot_ids', 'qualification_state', 'notes'];
    response.setHeader('Content-Disposition', 'attachment; filename="role-pipeline.csv"');
    send(response, 200, '\uFEFF' + [columns.map(csvCell).join(','), ...rows.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n', 'text/csv; charset=utf-8');
    return true;
  }
  return false;
}
