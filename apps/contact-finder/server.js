import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from './discovery.js';
import { discoverWebsite } from './website-discovery.js';

const root = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 160_000;
const now = () => new Date().toISOString();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function text(value, max = 300) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw fail(`Text must be at most ${max} characters.`);
  return value.trim();
}

export function normalizeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Expected a JSON object.');
  if (!['website', 'public', 'paste'].includes(body.mode)) throw fail('Choose website search, single page, or pasted text.');
  const input = {};
  for (const field of ['linkedinUrl', 'name', 'company', 'domain']) input[field] = text(body.input?.[field], field === 'linkedinUrl' ? 2000 : 300);
  if (input.linkedinUrl) {
    let url;
    try { url = new URL(input.linkedinUrl); } catch { throw fail('Enter a complete LinkedIn profile URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/(^|\.)linkedin\.com$/i.test(url.hostname)) throw fail('Enter a LinkedIn profile URL, or leave the reference blank.');
    url.search = ''; url.hash = '';
    input.linkedinUrl = url.href;
  }
  let sourceUrl = text(body.sourceUrl, 4000);
  const sourceText = text(body.sourceText, 100000);
  if (body.mode === 'website' && !sourceUrl) {
    if (!input.domain) throw fail('Enter a company domain or a starting website URL.');
    sourceUrl = /^https?:\/\//i.test(input.domain) ? input.domain : `https://${input.domain}`;
  }
  if (body.mode === 'public' && !sourceUrl) throw fail('Enter a public webpage URL.');
  if (body.mode === 'paste' && !sourceText) throw fail('Paste source text containing the contact information.');
  if (sourceUrl) {
    let url;
    try { url = new URL(sourceUrl); } catch { throw fail('Enter a complete source URL beginning with https:// or http://.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw fail('Source must be an HTTP(S) URL without credentials.');
    if (body.mode === 'website') {
      if (url.search) throw fail('Website search needs a URL without query parameters. Use Single page for a specific query URL.');
      url.hash = '';
      sourceUrl = url.href;
    }
  }
  const idempotencyKey = text(body.idempotencyKey, 120);
  if (!idempotencyKey) throw fail('A request ID is required. Reload the app and try again.');
  return { mode: body.mode, input, sourceUrl, sourceText, idempotencyKey, retry: body.retry === true };
}

export function csvCell(value) {
  let result = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(result) || /^[\t\r\n]/.test(result)) result = "'" + result;
  return '"' + result.replaceAll('"', '""') + '"';
}

const runDiscovery = args => args.mode === 'website' ? discoverWebsite(args) : discover(args);

export function createApp({ dataDir = join(root, 'data'), discovery = runDiscovery, configure, extraRoutes } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const dbFile = join(dataDir, 'contacts.sqlite');
  const db = new DatabaseSync(dbFile);
  chmodSync(dbFile, 0o600);
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL, document TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_fingerprint ON jobs(fingerprint);
    CREATE TABLE IF NOT EXISTS suppressed (email TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (request_key TEXT PRIMARY KEY, job_id TEXT NOT NULL, fingerprint TEXT NOT NULL);
    INSERT OR IGNORE INTO requests SELECT request_key, id, fingerprint FROM jobs;`);
  configure?.(db);
  const sessionToken = randomBytes(32).toString('hex');
  let active = 0;
  const pending = new Set();
  const getRaw = id => {
    const row = db.prepare('SELECT document FROM jobs WHERE id = ?').get(id);
    return row ? JSON.parse(row.document) : null;
  };
  const isSuppressed = email => !!db.prepare('SELECT email FROM suppressed WHERE email = ?').get(email.toLowerCase());
  const hydrated = job => job && ({ ...job, results: job.results.map(result => isSuppressed(result.email) ? { ...result, review: 'suppressed' } : result) });
  const getJob = id => hydrated(getRaw(id));
  const save = job => db.prepare('UPDATE jobs SET document = ? WHERE id = ?').run(JSON.stringify(job), job.id);
  for (const { document } of db.prepare('SELECT document FROM jobs').all()) {
    const job = JSON.parse(document);
    if (job.status === 'running') { job.status = 'interrupted'; job.error = 'The local app stopped during this search. Run it again to retry.'; job.updatedAt = now(); save(job); }
  }
  const allJobs = () => db.prepare('SELECT document FROM jobs ORDER BY rowid DESC LIMIT 200').all().map(row => hydrated(JSON.parse(row.document)));
  const send = (response, code, value, type = 'application/json; charset=utf-8') => {
    response.writeHead(code, { 'Content-Type': type });
    response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
  };
  async function bodyJson(request) {
    if (!request.headers['content-type']?.startsWith('application/json')) throw fail('JSON content type required.', 415);
    let size = 0; const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) throw fail('Request is too large.', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid JSON.'); }
  }
  function authorized(request) {
    const token = request.headers['x-local-token'];
    return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(sessionToken));
  }
  async function handle(request, response) {
    const port = server.address()?.port;
    const permittedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!permittedHosts.includes(request.headers.host)) throw fail('Unrecognized local host.', 403);
    const origin = request.headers.origin;
    if ((origin && origin !== `http://${request.headers.host}`) || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) throw fail('Only the local app can make this request.', 403);
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/api/status' && request.method === 'GET') return send(response, 200, { token: sessionToken, mode: 'public_sources_only', activeSearches: active });
    if (url.pathname.startsWith('/api/') && !authorized(request)) throw fail('Reload the app to reconnect to this local session.', 403);
    if (extraRoutes && await extraRoutes(request, response, url, { db, send, bodyJson, getJob, isSuppressed })) return;
    if (url.pathname === '/api/jobs' && request.method === 'GET') return send(response, 200, { jobs: allJobs() });
    if (/^\/api\/jobs\/[^/]+$/.test(url.pathname) && request.method === 'GET') {
      const job = getJob(url.pathname.split('/').pop());
      if (!job) throw fail('Search not found.', 404);
      return send(response, 200, { job });
    }
    if (url.pathname === '/api/discover' && request.method === 'POST') {
      const args = normalizeRequest(await bodyJson(request));
      const fingerprint = createHash('sha256').update(JSON.stringify({ mode: args.mode, input: args.input, sourceUrl: args.sourceUrl, sourceText: args.sourceText })).digest('hex');
      const sameKey = db.prepare('SELECT job_id AS id, fingerprint FROM requests WHERE request_key = ?').get(args.idempotencyKey);
      if (sameKey) {
        if (sameKey.fingerprint !== fingerprint) throw fail('Request ID was already used for different inputs.', 409);
        return send(response, 200, { job: getJob(sameKey.id), cached: true });
      }
      const previous = db.prepare('SELECT id FROM jobs WHERE fingerprint = ? ORDER BY rowid DESC LIMIT 1').get(fingerprint);
      const previousJob = previous && getJob(previous.id);
      if (previousJob && (previousJob.status === 'running' || !args.retry)) {
        db.prepare('INSERT INTO requests(request_key,job_id,fingerprint) VALUES (?,?,?)').run(args.idempotencyKey, previousJob.id, fingerprint);
        return send(response, 200, { job: previousJob, cached: true });
      }
      if (active >= 3) throw fail('Three page checks are already running. Wait for one to finish.', 429);
      const job = { id: randomUUID(), input: args.input, mode: args.mode, sourceUrl: args.sourceUrl, status: 'running', createdAt: now(), updatedAt: now(), results: [], error: null };
      db.prepare('INSERT INTO jobs(id,request_key,fingerprint,document) VALUES (?,?,?,?)').run(job.id, args.idempotencyKey, fingerprint, JSON.stringify(job));
      db.prepare('INSERT INTO requests(request_key,job_id,fingerprint) VALUES (?,?,?)').run(args.idempotencyKey, job.id, fingerprint);
      active++;
      const work = Promise.resolve().then(() => discovery(args)).then(discovered => {
        const results = Array.isArray(discovered) ? discovered : discovered.results;
        if (!Array.isArray(discovered) && discovered.coverage) job.coverage = discovered.coverage;
        job.results = results.map(result => ({ ...result, review: isSuppressed(result.email) ? 'suppressed' : 'pending' }));
        job.status = results.length ? 'complete' : 'no_result';
        if (job.coverage && !results.length && !job.coverage.pages.some(page => page.status === 'read')) {
          job.status = 'error';
          job.error = 'No pages could be read. See Pages checked for the access or connection issue.';
        }
      }).catch(error => {
        job.status = 'error'; job.error = error.publicMessage || error.message || 'The source could not be read.';
      }).finally(() => { job.updatedAt = now(); save(job); active--; pending.delete(work); });
      pending.add(work);
      return send(response, 202, { job });
    }
    if (url.pathname === '/api/review' && request.method === 'POST') {
      const body = await bodyJson(request);
      const job = getRaw(text(body.jobId, 100));
      if (!job) throw fail('Search not found.', 404);
      if (!['approved', 'pending', 'suppressed'].includes(body.review)) throw fail('Choose a valid review status.');
      const result = job.results.find(item => item.id === body.resultId);
      if (!result) throw fail('Email not found in this search.', 404);
      if (body.review !== 'suppressed' && isSuppressed(result.email)) throw fail('This address is excluded from exports across all searches.', 409);
      if (body.review === 'approved' && !job.input.name) throw fail('Enter the person’s name before confirming an email match. Run this search with a name first.');
      result.review = body.review;
      result.reviewedAt = now();
      if (body.review === 'suppressed') db.prepare('INSERT OR IGNORE INTO suppressed(email,created_at) VALUES (?,?)').run(result.email.toLowerCase(), now());
      job.updatedAt = now(); save(job);
      return send(response, 200, { job: getJob(job.id) });
    }
    if (url.pathname === '/api/export' && request.method === 'GET') {
      const seen = new Set(); const rows = [];
      // Export all reviewed records, even when the history pane is capped at 200 searches.
      for (const { document } of db.prepare('SELECT document FROM jobs ORDER BY rowid DESC').all()) {
        const job = hydrated(JSON.parse(document));
        for (const result of job.results) {
          const key = result.email.toLowerCase();
          if (result.review !== 'approved' || result.deliverability === 'invalid' || seen.has(key)) continue;
          seen.add(key);
          rows.push({ name: job.input.name, company: job.input.company, linkedin_url: job.input.linkedinUrl, email: result.email, ownership: 'user_confirmed_match', deliverability: result.deliverability, source_type: result.sourceType, source_urls: result.sources.map(source => source.url).filter(Boolean).join(' | '), observed_at: result.sources.map(source => source.observedAt).filter(Boolean).join(' | '), reviewed_at: result.reviewedAt, flags: result.flags.join(' | '), context: result.context });
        }
      }
      if (url.searchParams.get('format') === 'json') return send(response, 200, { exportedAt: now(), count: rows.length, contacts: rows });
      const headers = ['name','company','linkedin_url','email','ownership','deliverability','source_type','source_urls','observed_at','reviewed_at','flags','context'];
      response.setHeader('Content-Disposition', 'attachment; filename="reviewed-contacts.csv"');
      return send(response, 200, '\uFEFF' + [headers.map(csvCell).join(','), ...rows.map(row => headers.map(header => csvCell(row[header])).join(','))].join('\r\n') + '\r\n', 'text/csv; charset=utf-8');
    }
    if (url.pathname.startsWith('/api/')) throw fail('API route not found.', 404);
    const assets = { '/': ['index.html','text/html; charset=utf-8'], '/app.js': ['app.js','text/javascript; charset=utf-8'], '/style.css': ['style.css','text/css; charset=utf-8'] };
    const asset = assets[url.pathname];
    if (!asset || request.method !== 'GET') throw fail('Page not found.', 404);
    return send(response, 200, readFileSync(join(root, 'public', asset[0])), asset[1]);
  }
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    handle(request, response).catch(error => {
      if (!response.headersSent) send(response, error.status || 500, { error: error.status ? error.message : 'The local app encountered an error. Check that its data folder is writable.' });
      else response.end();
    });
  });
  server.requestTimeout = 30000;
  return { server, close: async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...pending]); db.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
  const app = createApp();
  app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open the existing app or choose another PORT.` : 'The local server could not start.'); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1', () => console.log(`Lead Finder is running at http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
