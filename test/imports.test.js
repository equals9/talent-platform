import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { planImport, importPreview, commitImport, importLegacyContacts, parseCsv } from '../packages/imports.js';
import { setupWorkspace, all, createRole } from '../packages/workspace.js';

const contactSchema = `CREATE TABLE jobs(id TEXT PRIMARY KEY,request_key TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,document TEXT NOT NULL); CREATE TABLE requests(request_key TEXT PRIMARY KEY,job_id TEXT NOT NULL,fingerprint TEXT NOT NULL); CREATE TABLE suppressed(email TEXT PRIMARY KEY,created_at TEXT NOT NULL);`;
function dbFixture(t) { const db = new DatabaseSync(':memory:'); db.exec(contactSchema); setupWorkspace(db); t.after(() => db.close()); return db; }
function tables(db) { return Object.fromEntries(['platform_roles', 'platform_candidates', 'platform_memberships', 'platform_events', 'platform_imports', 'jobs', 'requests', 'suppressed'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function legacy(t, { running = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'talent-legacy-source-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'source.sqlite'); const db = new DatabaseSync(file); db.exec(contactSchema);
  const job = { id: 'legacy-job', input: { name: 'Alex Example' }, mode: 'paste', sourceUrl: 'https://example.test/about', status: running ? 'running' : 'complete', createdAt: '2026-10-10T12:00:00Z', updatedAt: '2026-10-10T12:00:00Z', results: [{ id: 'legacy-result', email: 'alex@example.test', review: 'approved', deliverability: 'unknown', context: 'published', flags: [], sourceType: 'public_page', sources: [{ url: 'https://example.test/about', observedAt: '2026-10-10T12:00:00Z' }] }], error: null };
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(job.id, 'legacy-first', 'fingerprint-one', JSON.stringify(job));
  db.prepare('INSERT INTO requests VALUES(?,?,?)').run('legacy-first', job.id, 'fingerprint-one');
  db.prepare('INSERT INTO requests VALUES(?,?,?)').run('legacy-replayed', job.id, 'fingerprint-one');
  db.prepare('INSERT INTO suppressed VALUES(?,?)').run('alex@example.test', '2026-10-10T13:00:00Z'); db.close();
  return { file, job };
}

test('CSV supports quoted commas/newlines and rejects malformed headers, rows and unfinished quotes', () => {
  const parsed = parseCsv('\uFEFFperson_id,name,current_organization\r\np1,"Alex, Example","First line\nSecond ""quoted"" line"\r\n');
  assert.equal(parsed[0].name, 'Alex, Example'); assert.equal(parsed[0].current_organization, 'First line\nSecond "quoted" line');
  for (const value of ['person_id,name,name\np1,A,B', 'person_id,\np1,A', 'name,email\nA,a@example.test', 'person_id,name\np1,A,extra', 'person_id,name\np1,"unclosed', 'person_id,name\np1,"Name"junk']) assert.throws(() => parseCsv(value));
});

test('Candidate OS import keeps original IDs and observations; same names remain distinct and reimport records changed metadata', t => {
  const db = dbFixture(t);
  const first = planImport('candidate-os-csv', 'person_id,name,email,identity_state,pipeline_stage\np1,Same Name,hidden@example.test,verified,hired\np2,Same Name,other@example.test,verified,offer');
  assert.equal(importPreview(first).candidates, 2); assert.equal(all(db, 'platform_candidates').length, 0);
  const result = commitImport(db, first); assert.equal(result.candidatesCreated, 2);
  const candidates = all(db, 'platform_candidates'); assert.notEqual(candidates[0].id, candidates[1].id);
  assert.ok(candidates.every(candidate => candidate.provenance.ownership === 'unreviewed' && candidate.provenance.deliverability === 'unknown'));
  assert.ok(candidates.every(candidate => candidate.provenance.contactEvidence === 'not_supplied'));
  assert.deepEqual(candidates.map(candidate => candidate.sourceId).sort(), ['p1', 'p2']);
  assert.deepEqual(all(db, 'platform_memberships'), []);
  assert.equal(commitImport(db, first).replayed, true); assert.equal(all(db, 'platform_imports').length, 1);
  const observed = planImport('candidate-os-csv', 'person_id,name,email\np1,Changed Observation,new@example.test');
  const second = commitImport(db, observed); assert.equal(second.candidatesCreated, 0); assert.equal(second.reusedCandidates, 1);
  assert.equal(all(db, 'platform_candidates').length, 2);
  const retained = all(db, 'platform_events').find(item => item.action === 'import_observation_retained');
  assert.equal(retained.details.originalObservation.upstream.email, 'new@example.test');
  assert.equal(retained.details.originalObservation.sourceId, 'p1');
  assert.equal(all(db, 'platform_candidates').find(candidate => candidate.sourceId === 'p1').name, 'Same Name', 'new projection must not silently rewrite recruiter record');
});

test('TalentOS subset preserves original role/candidate IDs and source facts without inheriting asserted stages', t => {
  const db = dbFixture(t);
  const bundle = { kind: 'talentos.workspace', version: 1, exportedAt: '2026-10-11T12:00:00Z', searches: { 'original-search': { facts: { roleTitle: 'Research Engineer', companyName: 'Example', geography: 'Remote', jd: 'Evidence-bearing requirement', hiringManager: 'Owner' }, candidates: { c1: { id: 'original-candidate', name: 'Alex Example', currentCompany: 'Previous Org', geography: 'London', notes: 'Imported recruiter note', currentTitle: 'Engineer', profileUrls: ['https://example.test/alex'], pipelineStage: 'hired', email: 'metadata@example.test' } } } } };
  const plan = planImport('talentos-bundle', JSON.stringify(bundle)); assert.equal(importPreview(plan).roles, 1);
  const result = commitImport(db, plan); assert.equal(result.rolesCreated, 1); assert.equal(result.candidatesCreated, 1);
  const role = all(db, 'platform_roles')[0], candidate = all(db, 'platform_candidates')[0], membership = all(db, 'platform_memberships')[0];
  assert.equal(role.provenance.sourceId, 'original-search'); assert.equal(role.provenance.sourceFacts.hiringManager, 'Owner');
  assert.equal(candidate.sourceId, 'original-candidate'); assert.equal(candidate.provenance.upstream.searchId, 'original-search');
  assert.equal(candidate.notes, 'Imported recruiter note'); assert.equal(candidate.profileUrl, 'https://example.test/alex');
  assert.equal(membership.roleId, role.id); assert.equal(membership.candidateId, candidate.id); assert.equal(membership.stage, 'researched');
  assert.equal(candidate.email, undefined); assert.equal(candidate.provenance.deliverability, 'unknown');
  assert.match(result.warnings.join(' '), /not a lossless migration/);
  assert.equal(commitImport(db, plan).replayed, true); assert.equal(all(db, 'platform_roles').length, 1);
});

test('import transaction rolls back roles, candidates, memberships and events when a later candidate fails', t => {
  const db = dbFixture(t); createRole(db, { title: 'Existing owner record' }); const before = tables(db);
  // A controlled defect after plan validation probes the commit boundary,
  // independent from parser rejection before writes.
  const plan = planImport('talentos-bundle', JSON.stringify({ kind: 'talentos.workspace', version: 1, exportedAt: '2026-10-11T12:00:00Z', searches: { r1: { facts: { roleTitle: 'Import role' }, candidates: { a: { id: 'a', name: 'First Valid' }, b: { id: 'b', name: 'Second Valid' } } } } }));
  plan.candidates[1].input.name = '';
  assert.throws(() => commitImport(db, plan), /Candidate name is required/);
  assert.deepEqual(tables(db), before, 'failed commit must roll back all mutations and preserve owner record');
});

test('legacy contact consolidation copies review history, request identities and global exclusions read-only and idempotently', t => {
  const db = dbFixture(t); const source = legacy(t); const before = digest(source.file);
  const imported = importLegacyContacts(db, source.file); assert.equal(imported.jobsCreated, 1); assert.equal(imported.exclusionsRetained, 1);
  assert.deepEqual(JSON.parse(db.prepare('SELECT document FROM jobs').get().document), source.job);
  assert.deepEqual(db.prepare('SELECT request_key FROM requests ORDER BY request_key').all().map(row => row.request_key), ['legacy-first', 'legacy-replayed']);
  assert.equal(db.prepare('SELECT email FROM suppressed').get().email, 'alex@example.test');
  assert.equal(digest(source.file), before, 'source SQLite bytes must remain unchanged');
  assert.equal(importLegacyContacts(db, source.file).replayed, true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1); assert.equal(all(db, 'platform_imports').length, 1);
});

test('legacy history conflict rolls back earlier suppression and job writes', t => {
  const db = dbFixture(t); const source = legacy(t); const beforeSource = digest(source.file);
  db.prepare('INSERT INTO requests VALUES(?,?,?)').run('legacy-replayed', 'owner-job', 'owner-fingerprint');
  const before = tables(db);
  assert.throws(() => importLegacyContacts(db, source.file), /request identity conflicts/);
  assert.deepEqual(tables(db), before); assert.equal(digest(source.file), beforeSource);
});

test('legacy conflicting review history never overwrites owner record and running search is rejected', t => {
  const db = dbFixture(t); const source = legacy(t);
  const changed = { ...source.job, results: [{ ...source.job.results[0], review: 'pending' }] };
  db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(source.job.id, 'owner-request', 'owner-fingerprint', JSON.stringify(changed));
  const before = tables(db); assert.throws(() => importLegacyContacts(db, source.file), /differs between workspaces/); assert.deepEqual(tables(db), before);
  const running = legacy(t, { running: true }); assert.throws(() => importLegacyContacts(db, running.file), /original contact searches to finish/); assert.deepEqual(tables(db), before);
});

