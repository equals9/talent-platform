import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { statSync } from 'node:fs';

const PROJECT = 'talentos';
const fail = (message, status = 503) => Object.assign(new Error(message), { status, sourceProject: PROJECT });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, max = 20000) => typeof value === 'string' ? value.slice(0, max) : '';
const requiredColumns = {
  search_projects: ['id', 'role_title', 'company_name', 'geography', 'status', 'created_at', 'updated_at'],
  candidates: ['id', 'search_project_id', 'name', 'current_title', 'current_company', 'geography', 'stage', 'disposition', 'created_at', 'updated_at'],
  candidate_sources: ['id', 'candidate_id', 'url', 'source_type', 'provenance', 'asserted_at', 'retrieved_at', 'confirmed_at', 'created_at'],
  candidate_source_evidence: ['id', 'candidate_id', 'search_project_id', 'source_url', 'source_type', 'title', 'snippet', 'retrieved_at', 'verification_status', 'provenance', 'created_at'],
  profile_suppressions: ['id', 'kind', 'normalized_value', 'candidate_id', 'reason', 'recorded_at'],
};

// These are URL references, never instructions to fetch a profile. Reject local
// addresses and private upload/object routes before exposing a candidate subset.
export function talentOSPublicUrl(value) {
  if (typeof value !== 'string' || value.length > 3000) return null;
  let url; try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if ([...url.searchParams.keys()].some(key => /token|secret|password|api.?key|authorization|signature|credential/i.test(key))) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host.includes('.') && !isIP(host)) return null;
  if (/(?:^|\.)(?:localhost|local|internal|lan|test|invalid)$/.test(host)) return null;
  const ip = isIP(host);
  if (ip === 4) {
    const [a, b] = host.split('.').map(Number);
    if ([0, 10, 127].includes(a) || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
  }
  if (ip === 6 && (host === '::' || host === '::1' || /^(?:fc|fd|fe[89ab]|ff)/.test(host) || host.startsWith('::ffff:'))) return null;
  if (/\/(?:uploads?|private|internal|resumes?|documents?)\//i.test(url.pathname)) return null;
  url.hash = '';
  return url.href;
}

const limitValue = value => {
  const limit = value === undefined ? 25 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw fail('Choose a limit from 1 to 25.', 400);
  return limit;
};
const idValue = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw fail('Provide an original TalentOS record ID.', 400);
  return value;
};

function inspect(db) {
  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw fail(`TalentOS source schema is missing ${table}; no migration was applied.`);
    const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    if (columns.some(column => !actual.has(column))) throw fail(`TalentOS ${table} schema is incompatible; no migration was applied.`);
  }
}
function optionalRows(db, table, columns, where, id) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
  const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  if (columns.some(column => !actual.has(column)) || !actual.has('search_project_id')) throw fail(`TalentOS ${table} schema is incompatible; no migration was applied.`);
  return db.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE ${where} ORDER BY created_at,id`).all(id);
}
function parsePayload(value, source) {
  if (typeof value !== 'string' || value.length > 1000000) throw fail(`TalentOS ${source} payload cannot be safely read.`);
  let payload; try { payload = JSON.parse(value); } catch { throw fail(`TalentOS ${source} payload is invalid JSON.`); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail(`TalentOS ${source} payload is invalid.`);
  return payload;
}
function suppressionRows(db) {
  const count = db.prepare('SELECT count(*) AS n FROM profile_suppressions').get().n;
  if (count > 10000) throw fail('TalentOS exclusions exceed this adapter’s qualified limit; no partial exclusion list was returned.');
  return db.prepare('SELECT id,kind,normalized_value,candidate_id,reason,recorded_at FROM profile_suppressions ORDER BY id').all().map(row => {
    if (!['url', 'email'].includes(row.kind) || !row.normalized_value) throw fail('TalentOS contains an unsupported exclusion; review the source without modifying it.');
    return { kind: row.kind === 'url' ? 'profile_url' : 'email', value: row.normalized_value, sourceRecordId: row.id, sourceCandidateId: row.candidate_id, sourceProject: PROJECT, reason: row.reason, createdAt: row.recorded_at, observedAt: row.recorded_at };
  });
}
function sources(db, candidateId) {
  const rows = db.prepare('SELECT id,url,source_type,provenance,asserted_at,retrieved_at,confirmed_at,created_at FROM candidate_sources WHERE candidate_id=? ORDER BY created_at,id LIMIT 101').all(candidateId);
  if (rows.length > 100) throw fail('TalentOS candidate has more than 100 profile references; no partial evidence set was returned.');
  return rows.flatMap(row => {
      const url = talentOSPublicUrl(row.url); if (!url) return [];
      return [{ id: row.id, sourceRecordId: row.id, url, sourceType: row.source_type, provenance: row.provenance, observedAt: row.retrieved_at || row.asserted_at || row.created_at, confirmedAt: row.confirmed_at, authority: 'upstream_profile_reference', sourceProject: PROJECT }];
    });
}
function evidence(db, candidateId) {
  const rows = db.prepare('SELECT id,source_url,source_type,title,snippet,retrieved_at,verification_status,provenance FROM candidate_source_evidence WHERE candidate_id=? ORDER BY retrieved_at,id LIMIT 101').all(candidateId);
  if (rows.length > 100) throw fail('TalentOS candidate has more than 100 evidence observations; no partial evidence set was returned.');
  return rows.flatMap(row => {
      const url = talentOSPublicUrl(row.source_url); if (!url) return [];
      // Search-result snippets are declared public discovery evidence in the
      // source schema. Imports and candidate-provided text may be private.
      if (row.provenance !== 'search_result') return [];
      return [{ id: row.id, sourceRecordId: row.id, url, sourceUrl: url, sourceType: row.source_type, title: text(row.title, 500), quote: text(row.snippet, 10000), quoteTruncated: typeof row.snippet === 'string' && row.snippet.length > 10000, observedAt: row.retrieved_at, status: row.verification_status, provenance: row.provenance, authority: 'upstream_source_observation', sourceProject: PROJECT }];
    });
}
function candidateRow(db, row) {
  const refs = sources(db, row.id), observations = evidence(db, row.id);
  const urls = [...new Set([...refs.map(ref => ref.url), ...observations.map(ref => ref.url)])];
  if (!urls.length) return null;
  return { id: row.id, sourceId: row.id, sourceRoleId: row.search_project_id, name: text(row.name, 300), title: text(row.current_title, 300), company: text(row.current_company, 300), location: text(row.geography, 300), profileUrl: urls[0], profileUrls: urls, sources: refs, evidence: observations, contacts: [], ownership: 'unreviewed', deliverability: 'unknown', sourceProject: PROJECT, authority: 'upstream_recruiter_record', observedAt: row.updated_at, upstream: { stage: row.stage, disposition: row.disposition }, warnings: ['A public profile reference is not proof of person identity, contact ownership, or qualification. Source snippets retain their upstream review status.'] };
}
const candidateColumns = 'id,search_project_id,name,current_title,current_company,geography,stage,disposition,created_at,updated_at';
function roleRow(row) {
  return { id: row.id, sourceId: row.id, title: text(row.role_title, 300), company: text(row.company_name, 300), location: text(row.geography, 300), description: '', criteria: [], sourceProject: PROJECT, upstreamStatus: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}
function roleDetails(db, id) {
  const row = db.prepare('SELECT id,role_title,company_name,geography,status,created_at,updated_at FROM search_projects WHERE id=?').get(id);
  if (!row) throw fail('TalentOS role was not found.', 404);
  const jobBriefs = optionalRows(db, 'job_descriptions', ['id','source','raw_text','url','created_at'], 'search_project_id=?', id).map(brief => ({ sourceRecordId: brief.id, source: brief.source, quote: text(brief.raw_text), quoteTruncated: typeof brief.raw_text === 'string' && brief.raw_text.length > 20000, url: talentOSPublicUrl(brief.url), observedAt: brief.created_at, sourceProject: PROJECT, authority: 'upstream_job_brief' }));
  const role = { ...roleRow(row), description: jobBriefs.at(-1)?.quote || '', jobBriefs, criteria: [], warnings: [] };
  const intelligence = optionalRows(db, 'hiring_intelligence', ['id','payload','created_at','updated_at'], 'search_project_id=?', id);
  for (const record of intelligence) {
    const payload = parsePayload(record.payload, 'hiring_intelligence');
    const requirements = payload.intent?.requirements;
    if (requirements !== undefined && !Array.isArray(requirements)) throw fail('TalentOS requirements must be an array.');
    const statements = Array.isArray(payload.intent?.statements) ? payload.intent.statements : [];
    for (const [index, criterion] of (requirements || []).slice(0,100).entries()) {
      if (!criterion || typeof criterion !== 'object') throw fail('TalentOS contains an invalid requirement.');
      const statement = text(criterion.statement,10000), origin = text(criterion.origin,80);
      const exactQuote = !!statement && (origin === 'jd' ? jobBriefs.some(brief => brief.quote.includes(statement)) : origin === 'manager_statement' && statements.some(source => typeof source.text === 'string' && source.text.includes(statement)));
      role.criteria.push({ id: text(criterion.id,200) || `${record.id}:${index}`, text: text(criterion.label,1000), statement, definition: text(criterion.definition,10000), kind: text(criterion.kind,80), status: text(criterion.status,80), provenance: origin, assertedBy: text(criterion.assertedBy,300), contested: criterion.contested === true, evidenceSpec: Array.isArray(criterion.evidenceSpec) ? criterion.evidenceSpec.filter(value => typeof value === 'string').slice(0,25).map(value => text(value,2000)) : [], quoteSupport: exactQuote ? 'exact_source_quote' : 'not_located', authority: 'upstream_derived_criterion', sourceRecordId: record.id, sourceProject: PROJECT, observedAt: record.updated_at });
    }
  }
  if (!role.criteria.length) {
    for (const [table, fields] of [['success_profiles',[['mustHave','must_have'],['preferred','preferred'],['trainable','trainable']]],['role_intelligence',[['hardRequirements','must_have'],['preferences','preferred']]]]) {
      for (const record of optionalRows(db, table, ['id','payload','created_at','updated_at'], 'search_project_id=?', id)) {
        const payload = parsePayload(record.payload,table);
        for (const [field, kind] of fields) {
          if (payload[field] !== undefined && !Array.isArray(payload[field])) throw fail(`TalentOS ${table} criteria are invalid.`);
          for (const [index, criterion] of (payload[field] || []).slice(0,100).entries()) {
            if (!criterion || typeof criterion !== 'object' || typeof criterion.text !== 'string') throw fail(`TalentOS ${table} criterion is invalid.`);
            role.criteria.push({ id: text(criterion.id,200) || `${record.id}:${field}:${index}`, text: text(criterion.text,10000), statement: '', definition: '', kind, status: 'upstream_unreviewed', provenance: text(criterion.provenance,80), quoteSupport: 'not_supplied', authority: 'upstream_derived_criterion', sourceRecordId: record.id, sourceProject: PROJECT, observedAt: record.updated_at });
          }
        }
      }
    }
  }
  role.warnings.push('Criteria are upstream interpretations. Exact quote support establishes the source phrase only; it does not establish recruiter agreement or candidate fit.');
  return role;
}

/** A trusted operator passes this path at startup; HTTP inputs never choose it. */
export function createTalentOSReader({ databasePath } = {}) {
  if (typeof databasePath !== 'string' || !isAbsolute(databasePath)) throw fail('Configure an absolute TalentOS databasePath in local operator configuration.',400);
  function snapshot(work) {
    let db;
    try {
      if (!statSync(databasePath).isFile()) throw fail('TalentOS source database is not a regular file.');
      db = new DatabaseSync(databasePath, { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN');
      inspect(db);
      const result = work(db);
      db.exec('ROLLBACK');
      return { sourceProject: PROJECT, projectId: PROJECT, ...result, snapshotHash: digest(result) };
    } catch(error) {
      if (error.sourceProject === PROJECT) throw error;
      throw fail(error.code === 'ENOENT' ? 'TalentOS source database is offline or missing; no database was created.' : 'TalentOS source database could not be read; no changes were applied.');
    } finally { if (db) db.close(); }
  }
  return {
    listRoles({ limit } = {}) {
      const count = limitValue(limit);
      return snapshot(db => ({ roles: db.prepare('SELECT id,role_title,company_name,geography,status,created_at,updated_at FROM search_projects ORDER BY updated_at DESC,id LIMIT ?').all(count).map(roleRow) }));
    },
    roleDetails(sourceRoleId) { const id = idValue(sourceRoleId); return snapshot(db => ({ role: roleDetails(db,id) })); },
    listCandidates({ sourceRoleId, query = '', limit } = {}) {
      const count = limitValue(limit); if (sourceRoleId !== undefined) idValue(sourceRoleId);
      if (typeof query !== 'string' || query.length > 300) throw fail('Candidate name query must be at most 300 characters.',400);
      // A bounded professional projection; private CV/profile JSON is absent
      // from SELECT, and an actual public reference is required afterwards.
      return snapshot(db => {
        const rows = db.prepare(`SELECT ${candidateColumns} FROM candidates WHERE (? IS NULL OR search_project_id=?) AND (?='' OR instr(lower(name),lower(?))>0) AND (EXISTS (SELECT 1 FROM candidate_sources s WHERE s.candidate_id=candidates.id) OR EXISTS (SELECT 1 FROM candidate_source_evidence e WHERE e.candidate_id=candidates.id)) ORDER BY updated_at DESC,id LIMIT 250`).all(sourceRoleId || null, sourceRoleId || null,query,query);
        const candidates = []; for(const row of rows) { const candidate = candidateRow(db,row); if(candidate) candidates.push(candidate); if(candidates.length === count) break; }
        return { candidates, suppressions: suppressionRows(db), limited: rows.length === 250, warnings: ['Only candidates with valid public-source references appear. Private candidate documents and inferred contact values are not read.'] };
      });
    },
    candidateDetails(sourceCandidateId) {
      const id = idValue(sourceCandidateId);
      return snapshot(db => {
        const row = db.prepare(`SELECT ${candidateColumns} FROM candidates WHERE id=?`).get(id);
        if (!row) throw fail('TalentOS candidate was not found.',404);
        const candidate = candidateRow(db,row);
        if (!candidate) throw fail('TalentOS candidate has no supported public-source reference and is excluded from this adapter.',403);
        return { candidate, suppressions: suppressionRows(db), warnings: candidate.warnings };
      });
    },
    suppressions() { return snapshot(db => ({ suppressions: suppressionRows(db) })); },
    status() {
      return snapshot(db => {
        const counts = { roles: db.prepare('SELECT count(*) n FROM search_projects').get().n, candidates: db.prepare('SELECT count(*) n FROM candidates').get().n, publicReferenceRows: db.prepare('SELECT count(*) n FROM candidate_sources').get().n, sourceEvidenceRows: db.prepare('SELECT count(*) n FROM candidate_source_evidence').get().n, exclusions: db.prepare('SELECT count(*) n FROM profile_suppressions').get().n };
        return { state: 'available_read_only', available: true, readOnly: true, counts, ...counts, queryOnly: db.prepare('PRAGMA query_only').get().query_only === 1 };
      });
    },
  };
}
