import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createCandidate, createRole, attachCandidate, string, link, event } from './workspace.js';

const fail = message => Object.assign(new Error(message), { status: 400 });
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function parseCsv(content) {
  const text = string(content, 'CSV', 120000, true).replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; afterQuote = true; } }
      else cell += character;
      continue;
    }
    if (afterQuote && ![',', '\r', '\n'].includes(character)) throw fail('Unexpected text after a quoted CSV value.');
    if (character === '"') { if (cell) throw fail('A CSV quote must start the value.'); quoted = true; continue; }
    if (character === ',' || character === '\n' || character === '\r') {
      row.push(cell); cell = ''; afterQuote = false;
      if (character !== ',') { if (row.some(value => value)) rows.push(row); row = []; if (character === '\r' && text[i + 1] === '\n') i++; }
    } else cell += character;
  }
  if (quoted) throw fail('The CSV has an unfinished quoted value.');
  row.push(cell); if (row.some(value => value)) rows.push(row);
  if (rows.length < 2) throw fail('Provide a header and at least one candidate row.');
  const headers = rows.shift().map(header => header.trim());
  if (new Set(headers).size !== headers.length || headers.some(header => !header)) throw fail('CSV headers must be nonempty and unique.');
  if (!headers.includes('person_id') || !headers.includes('name')) throw fail('Candidate OS CSV needs person_id and name columns.');
  if (rows.length > 500) throw fail('Import at most 500 candidates at a time.');
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw fail(`CSV row ${index + 2} has ${values.length} values; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  });
}

export function planImport(format, content) {
  string(content, 'Import content', 120000, true);
  const candidates = [], roles = [], warnings = [];
  if (format === 'candidate-os-csv') {
    for (const row of parseCsv(content)) {
      const sourceId = string(row.person_id, 'Original person ID', 120, true);
      candidates.push({
        input: { name: string(row.name, 'Candidate name', 300, true), company: string(row.current_organization, 'Company'), location: string([row.city, row.state].filter(Boolean).join(', '), 'Location'), profileUrl: link(row.profile_url), notes: '' },
        provenance: { kind: 'imported_projection', sourceProject: 'candidate-intelligence-os', sourceId, originKey: `candidate-intelligence-os:${sourceId}`, observedAt: string(row.last_observed_at, 'Original observation time'), importHash: hash(content), authority: 'upstream_projection',
          upstream: Object.fromEntries(['credentials', 'current_title', 'profession', 'specialty', 'identity_state', 'anchor', 'independent_sources', 'corroborated', 'email', 'email_status', 'email_source', 'last_observed_at', 'fit_score', 'rank', 'match_reasons', 'pipeline_stage', 'saved_at', 'search_run_id'].filter(key => row[key]).map(key => [key, string(row[key], key, 10000)])),
          contactEvidence: 'not_supplied', deliverability: 'unknown', ownership: 'unreviewed'
        }
      });
    }
    warnings.push('Candidate OS CSV is a projection. Email source labels are retained as metadata; contact evidence and deliverability are not established. Imported emails cannot be approved or exported without separate source research.');
    warnings.push('Original identity, score, and pipeline stage are upstream metadata. They do not merge identities, rank candidates, or change this workspace’s pipeline.');
  } else if (format === 'talentos-bundle') {
    let bundle;
    try { bundle = JSON.parse(content); } catch { throw fail('Provide a valid TalentOS workspace JSON file.'); }
    if (!object(bundle) || bundle.kind !== 'talentos.workspace' || bundle.version !== 1 || !object(bundle.searches)) throw fail('Expected talentos.workspace version 1 with a searches object.');
    if (typeof bundle.exportedAt !== 'string' || !Number.isFinite(Date.parse(bundle.exportedAt))) throw fail('TalentOS export needs a valid exportedAt timestamp.');
    if (Object.keys(bundle.searches).length > 100) throw fail('Import at most 100 roles at a time.');
    for (const [searchId, search] of Object.entries(bundle.searches)) {
      if (!object(search) || !object(search.facts) || !object(search.candidates || {})) throw fail(`Search ${searchId} needs facts and candidates objects.`);
      const roleIndex = roles.length;
      roles.push({ title: string(search.facts.roleTitle, 'Role title', 300, true), company: string(search.facts.companyName, 'Company'), location: string(search.facts.geography, 'Location'), description: string(search.facts.jd, 'Role brief', 20000), originalId: string(searchId, 'Original search ID', 120, true), sourceProject: 'talentos', sourceFacts: search.facts });
      for (const raw of Object.values(search.candidates || {})) {
        if (!object(raw)) throw fail('Each TalentOS candidate must be an object.');
        const sourceId = string(raw.id, 'Original candidate ID', 120, true);
        if (raw.profileUrls !== undefined && !Array.isArray(raw.profileUrls)) throw fail('Candidate profileUrls must be an array.');
        const profileUrls = (raw.profileUrls || []).map(link);
        candidates.push({ roleIndex, input: { name: string(raw.name, 'Candidate name', 300, true), company: string(raw.currentCompany, 'Company'), location: string(raw.geography, 'Location'), profileUrl: profileUrls[0] || '', notes: string(raw.notes, 'Recruiter notes', 10000) },
          provenance: { kind: 'imported_workspace_subset', sourceProject: 'talentos', sourceId, originKey: `talentos:${sourceId}`, observedAt: bundle.exportedAt, importHash: hash(content), authority: 'upstream_recruiter_record', upstream: { searchId, currentTitle: string(raw.currentTitle, 'Title'), createdAt: string(raw.createdAt, 'Original creation time'), profileUrls }, contactEvidence: 'not_supplied', deliverability: 'unknown', ownership: 'unreviewed' }
        });
      }
    }
    if (candidates.length > 500) throw fail('Import at most 500 candidates at a time.');
    warnings.push('TalentOS v1 omits detailed contact evidence, original pipeline dispositions/stages, notice history and generated artifacts. This is its declared role/candidate subset, not a lossless migration. Candidates enter the imported role at researched.');
  } else throw fail('Choose Candidate OS CSV or TalentOS workspace JSON.');
  return { roles, candidates, warnings, digest: hash(`${format}\n${content}`), format };
}

export function importPreview(plan) {
  return { roles: plan.roles.length, candidates: plan.candidates.length, warnings: plan.warnings, samples: plan.candidates.slice(0, 5).map(row => ({ name: row.input.name, company: row.input.company, location: row.input.location, sourceProject: row.provenance.sourceProject })) };
}

export function commitImport(db, plan) {
  const old = db.prepare('SELECT document FROM platform_imports WHERE id=?').get(plan.digest);
  if (old) return { ...JSON.parse(old.document), replayed: true };
  return transaction(db, () => {
    const roleIds = plan.roles.map(row => {
      const role = createRole(db, row);
      role.provenance = { kind: 'imported_role', sourceProject: row.sourceProject, sourceId: row.originalId, importHash: plan.digest, sourceFacts: row.sourceFacts };
      db.prepare('UPDATE platform_roles SET document=? WHERE id=?').run(JSON.stringify(role), role.id);
      return role.id;
    });
    let candidatesCreated = 0, reusedCandidates = 0;
    for (const row of plan.candidates) {
      const result = createCandidate(db, row.input, row.provenance);
      if (result.reused) reusedCandidates++; else candidatesCreated++;
      if (row.roleIndex !== undefined) attachCandidate(db, { candidateId: result.candidate.id, roleId: roleIds[row.roleIndex] });
      if (result.reused) event(db, result.candidate.id, 'import_observation_retained', { importHash: plan.digest, originalObservation: row.provenance });
    }
    const imported = { id: plan.digest, format: plan.format, at: new Date().toISOString(), rolesCreated: roleIds.length, candidatesCreated, reusedCandidates, warnings: plan.warnings };
    db.prepare('INSERT INTO platform_imports(id,document) VALUES(?,?)').run(imported.id, JSON.stringify(imported));
    return imported;
  });
}

// A one-time local contact-history consolidation. The original store is opened
// read-only; exclusions and request identities move before any future exports.
export function importLegacyContacts(db, sourceFile) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  let snapshot;
  try {
    snapshot = Object.fromEntries(['jobs', 'requests', 'suppressed'].map(table => [table, source.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally { source.close(); }
  if (snapshot.jobs.some(row => JSON.parse(row.document).status === 'running')) throw fail('Wait for the original contact searches to finish before consolidation.');
  const id = `lead-finder:${hash(JSON.stringify(snapshot))}`;
  const previous = db.prepare('SELECT document FROM platform_imports WHERE id=?').get(id);
  if (previous) return { ...JSON.parse(previous.document), replayed: true };
  return transaction(db, () => {
    for (const row of snapshot.suppressed) db.prepare('INSERT OR IGNORE INTO suppressed(email,created_at) VALUES(?,?)').run(row.email, row.created_at);
    let jobsCreated = 0;
    for (const row of snapshot.jobs) {
      const existing = db.prepare('SELECT document FROM jobs WHERE id=?').get(row.id);
      if (existing) {
        if (existing.document !== row.document) throw fail('A contact search differs between workspaces. Reconcile its review history explicitly instead of overwriting it.');
        continue;
      }
      db.prepare('INSERT INTO jobs(id,request_key,fingerprint,document) VALUES(?,?,?,?)').run(row.id, row.request_key, row.fingerprint, row.document); jobsCreated++;
    }
    for (const row of snapshot.requests) {
      const existing = db.prepare('SELECT * FROM requests WHERE request_key=?').get(row.request_key);
      if (existing && (existing.job_id !== row.job_id || existing.fingerprint !== row.fingerprint)) throw fail('A request identity conflicts across stores.');
      db.prepare('INSERT OR IGNORE INTO requests(request_key,job_id,fingerprint) VALUES(?,?,?)').run(row.request_key, row.job_id, row.fingerprint);
    }
    const imported = { id, format: 'lead-finder-history', at: new Date().toISOString(), jobsCreated, exclusionsRetained: snapshot.suppressed.length, sourceFile };
    db.prepare('INSERT INTO platform_imports(id,document) VALUES(?,?)').run(id, JSON.stringify(imported));
    return imported;
  });
}
