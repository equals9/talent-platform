import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTalentOSReader, talentOSPublicUrl } from '../packages/talentos-reader.js';

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const schema = `
CREATE TABLE search_projects(id TEXT PRIMARY KEY, role_title TEXT, company_name TEXT, geography TEXT, status TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE job_descriptions(id TEXT PRIMARY KEY,search_project_id TEXT,source TEXT,raw_text TEXT,url TEXT,created_at TEXT);
CREATE TABLE hiring_intelligence(id TEXT PRIMARY KEY,search_project_id TEXT,payload TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE success_profiles(id TEXT PRIMARY KEY,search_project_id TEXT,payload TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE role_intelligence(id TEXT PRIMARY KEY,search_project_id TEXT,payload TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE candidates(id TEXT PRIMARY KEY,search_project_id TEXT,name TEXT,current_title TEXT,current_company TEXT,geography TEXT,stage TEXT,disposition TEXT,created_at TEXT,updated_at TEXT,resume_text TEXT,profile TEXT,recruiter_notes TEXT);
CREATE TABLE candidate_sources(id TEXT PRIMARY KEY,candidate_id TEXT,url TEXT,source_type TEXT,provenance TEXT,asserted_at TEXT,retrieved_at TEXT,confirmed_at TEXT,created_at TEXT);
CREATE TABLE candidate_source_evidence(id TEXT PRIMARY KEY,candidate_id TEXT,search_project_id TEXT,source_url TEXT,source_type TEXT,title TEXT,snippet TEXT,retrieved_at TEXT,verification_status TEXT,provenance TEXT,created_at TEXT);
CREATE TABLE profile_suppressions(id TEXT PRIMARY KEY,kind TEXT,normalized_value TEXT,candidate_id TEXT,reason TEXT,recorded_at TEXT);
`;
const observed = '2026-10-10T12:00:00Z';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'talentos-reader-')); t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file = join(directory,'source.sqlite'); const db = new DatabaseSync(file); db.exec(schema);
  db.prepare('INSERT INTO search_projects VALUES(?,?,?,?,?,?,?)').run('role-1','Engineer','Example','Remote','open',observed,observed);
  db.prepare('INSERT INTO job_descriptions VALUES(?,?,?,?,?,?)').run('jd-1','role-1','url','Experience building SQLite applications.','https://example.com/jobs/engineer',observed);
  db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('person-1','role-1','Alex Example','Engineer','Previous Example','Remote','hired','active',observed,observed,'PRIVATE RESUME hidden@example.com','{"secret":"PRIVATE PROFILE"}','PRIVATE NOTE');
  db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('private-1','role-1','Private Example','Engineer','Other','Remote','interview','active',observed,observed,'SECRET RESUME','{"email":"private@example.com"}','SECRET NOTE');
  db.prepare('INSERT INTO candidate_sources VALUES(?,?,?,?,?,?,?,?,?)').run('source-1','person-1','https://github.com/example-professional','professional','recruiter_added',observed,null,null,observed);
  db.prepare('INSERT INTO candidate_sources VALUES(?,?,?,?,?,?,?,?,?)').run('source-private','private-1','http://localhost/uploads/private.pdf','cv','candidate_provided',observed,null,null,observed);
  db.prepare('INSERT INTO candidate_source_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('evidence-1','person-1','role-1','https://example.com/team/alex','professional','Public team page','Alex maintains SQLite applications.',observed,'unverified','search_result',observed);
  db.prepare('INSERT INTO candidate_source_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('private-evidence','person-1','role-1','https://example.com/some-path','cv','Private upload','DO NOT PUBLISH THIS PRIVATE CV',observed,'verified','candidate_provided',observed);
  db.prepare('INSERT INTO profile_suppressions VALUES(?,?,?,?,?,?)').run('exclude-email','email','alex@example.com','person-1','objected',observed);
  db.prepare('INSERT INTO profile_suppressions VALUES(?,?,?,?,?,?)').run('exclude-url','url','https://github.com/example-professional','person-1','denied',observed);
  db.close(); return {file,reader:createTalentOSReader({databasePath:file})};
}

test('reader opens source query-only, retains record hashes, and never selects private candidate blobs',t=>{
  const {file,reader}=fixture(t), before=hash(file);
  assert.equal(reader.status().queryOnly,true);
  assert.equal(reader.status().state,'available_read_only');
  const results=reader.listCandidates();
  assert.equal(results.candidates.length,1);
  const person=results.candidates[0];
  assert.equal(person.name,'Alex Example'); assert.equal(person.title,'Engineer');
  assert.equal(person.sourceId,'person-1'); assert.equal(person.sourceRoleId,'role-1');
  assert.deepEqual(person.upstream,{stage:'hired',disposition:'active'});
  assert.equal(person.ownership,'unreviewed');assert.equal(person.deliverability,'unknown');assert.deepEqual(person.contacts,[]);
  const output=JSON.stringify(reader.candidateDetails('person-1'));
  for(const privateValue of ['PRIVATE RESUME','PRIVATE PROFILE','PRIVATE NOTE','DO NOT PUBLISH','hidden@example.com']) assert.ok(!output.includes(privateValue));
  assert.equal(reader.candidateDetails('person-1').snapshotHash,reader.candidateDetails('person-1').snapshotHash);
  assert.equal(hash(file),before,'all source bytes remain unchanged after reads');
});

test('public discovery snippets keep the exact quote, URL, source IDs, timestamp and original unverified status',t=>{
  const {reader}=fixture(t);const detail=reader.candidateDetails('person-1');const item=detail.candidate.evidence[0];
  assert.equal(detail.candidate.evidence.length,1);
  assert.equal(item.sourceRecordId,'evidence-1'); assert.equal(item.url,'https://example.com/team/alex');
  assert.equal(item.quote,'Alex maintains SQLite applications.');assert.equal(item.observedAt,observed);
  assert.equal(item.status,'unverified');assert.equal(item.provenance,'search_result');
  assert.equal(detail.candidate.sources[0].authority,'upstream_profile_reference');
});

test('global profile and email exclusions survive independently of selected-person reads',t=>{
  const {reader}=fixture(t);const suppression=reader.suppressions();assert.equal(suppression.suppressions.length,2);
  assert.deepEqual(suppression.suppressions.map(row=>row.kind).sort(),['email','profile_url']);
  assert.equal(suppression.suppressions.find(row=>row.kind==='email').value,'alex@example.com');
  assert.equal(suppression.suppressions.find(row=>row.kind==='profile_url').reason,'denied');
  assert.deepEqual(reader.candidateDetails('person-1').suppressions,suppression.suppressions);
});

test('private-only candidates fail closed, literal name searches are bounded, and missing IDs differ from denied records',t=>{
  const {reader}=fixture(t);
  assert.throws(()=>reader.candidateDetails('private-1'),error=>error.status===403);
  assert.throws(()=>reader.candidateDetails('unknown'),error=>error.status===404);
  assert.equal(reader.listCandidates({query:'%' }).candidates.length,0,'SQL wildcard must not expand name query');
  assert.equal(reader.listCandidates({query:'Alex',sourceRoleId:'role-1',limit:1}).candidates.length,1);
  for(const limit of [0,26,1.5,'bad']) assert.throws(()=>reader.listCandidates({limit}),error=>error.status===400);
  assert.throws(()=>reader.listCandidates({sourceRoleId:''}),error=>error.status===400);
});

test('canonical role requirements retain verbatim quotes and identify unsupported upstream inference',t=>{
  const {file,reader}=fixture(t);const db=new DatabaseSync(file);
  const payload={intent:{requirements:[
    {id:'criterion-1',label:'SQLite',statement:'Experience building SQLite applications.',definition:'Build SQLite applications',kind:'must_have',origin:'jd',status:'explicit',evidenceSpec:['Public implementation']},
    {id:'criterion-2',label:'Unknown inferred skill',statement:'Invented threshold',definition:'Unknown',kind:'preferred',origin:'model_inference',status:'assumed',evidenceSpec:[]},
    {id:'criterion-3',label:'Manager requirement',statement:'Own deployment',definition:'Deploy',kind:'preferred',origin:'manager_statement',status:'explicit',assertedBy:'Hiring manager',contested:true,evidenceSpec:[]},
  ],statements:[{id:'statement-1',text:'Please own deployment.',at:observed}]}};
  db.prepare('INSERT INTO hiring_intelligence VALUES(?,?,?,?,?)').run('intelligence-1','role-1',JSON.stringify(payload),observed,observed); db.close();
  const before=hash(file);const role=reader.roleDetails('role-1').role;
  assert.equal(reader.listRoles().roles[0].id,'role-1');assert.equal(role.description,'Experience building SQLite applications.');
  assert.equal(role.jobBriefs[0].sourceRecordId,'jd-1');assert.equal(role.jobBriefs[0].observedAt,observed);
  assert.equal(role.criteria[0].statement,'Experience building SQLite applications.');assert.equal(role.criteria[0].quoteSupport,'exact_source_quote');
  assert.equal(role.criteria[0].authority,'upstream_derived_criterion');assert.equal(role.criteria[0].sourceRecordId,'intelligence-1');
  assert.equal(role.criteria[1].quoteSupport,'not_located');assert.equal(role.criteria[1].provenance,'model_inference');
  assert.equal(role.criteria[2].quoteSupport,'not_located','case-sensitive verbatim quote must not be fabricated');assert.equal(role.criteria[2].contested,true);
  assert.equal(hash(file),before);
});

test('legacy role documents remain derived and cannot fabricate source quote support',t=>{
  const {file,reader}=fixture(t);const db=new DatabaseSync(file);
  db.prepare('INSERT INTO success_profiles VALUES(?,?,?,?,?)').run('success-1','role-1',JSON.stringify({mustHave:[{id:'must-1',text:'SQLite skill',provenance:'model_inference'}],preferred:[],trainable:[]}),observed,observed);db.close();
  const criterion=reader.roleDetails('role-1').role.criteria[0];assert.equal(criterion.quoteSupport,'not_supplied');assert.equal(criterion.statement,'');assert.equal(criterion.authority,'upstream_derived_criterion');
});

test('schema drift, malformed criteria and missing exclusion capability fail without migrations or writes',t=>{
  const {file,reader}=fixture(t);let db=new DatabaseSync(file);
  db.prepare('INSERT INTO hiring_intelligence VALUES(?,?,?,?,?)').run('bad','role-1','{broken',observed,observed);db.close();
  let before=hash(file);assert.throws(()=>reader.roleDetails('role-1'),/invalid JSON/);assert.equal(hash(file),before);
  db=new DatabaseSync(file);db.exec('DROP TABLE profile_suppressions');db.close();before=hash(file);
  assert.throws(()=>reader.listCandidates(),/missing profile_suppressions/);assert.equal(hash(file),before);
});

test('operator path is mandatory and an offline source never creates a database',t=>{
  const directory=mkdtempSync(join(tmpdir(),'talentos-offline-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  for(const value of [undefined,'relative.sqlite','https://example.com/db'])assert.throws(()=>createTalentOSReader({databasePath:value}),/absolute/);
  const file=join(directory,'missing.sqlite');const reader=createTalentOSReader({databasePath:file});assert.throws(()=>reader.listRoles(),/offline or missing/);assert.equal(existsSync(file),false);
});

test('profile reference validation rejects local/private/upload sources without fetching any URL',()=>{
  for(const value of ['http://localhost/a','http://127.1/a','http://169.254.1.2/a','http://172.16.1.2/a','http://10.0.0.1/a','http://[::1]/a','https://user:pass@example.com/a','file:///private/cv.pdf','https://example.com/uploads/cv.pdf','http://a.internal/a','https://example.com/profile?token=PRIVATE','https://example.com/profile?X-Amz-Credential=PRIVATE'])assert.equal(talentOSPublicUrl(value),null,value);
  assert.equal(talentOSPublicUrl('https://github.com/person#about'),'https://github.com/person');
});
