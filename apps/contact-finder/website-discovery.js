import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { safeFetch, validatePublicUrl, decodeEntities, extractEmails, publicPageMetadata } from './discovery.js';
import { parseRobots } from './robots.js';

const MAX_PAGES = 5;
const MAX_DEPTH = 2;
const MAX_RESULTS = 50;
const MAX_DURATION_MS = 45_000;
const stamp = () => new Date().toISOString();
const blocked = message => Object.assign(new Error(message), { blocked: true });

function canonicalOrigins(url) {
  const bare = url.hostname.replace(/^www\./i, '');
  const hosts = [bare, `www.${bare}`];
  const protocols = url.protocol === 'http:' ? ['http:', 'https:'] : ['https:'];
  return protocols.flatMap(protocol => hosts.map(host => `${protocol}//${host}`));
}

// A source page may suggest candidates, but it never supplies instructions or
// expands the permitted origin. Only observed anchors with narrow link intent
// are considered; a blog title containing the word "about" is insufficient.
export function contactLinks(html, pageUrl, name = '') {
  const base = new URL(pageUrl);
  const clean = String(html).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const words = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]{2,}/g) || [];
  const found = new Map();
  for (const match of clean.matchAll(/<a\b([^>]*?)>([\s\S]*?)<\/a\s*>/gi)) {
    const attributes = match[1];
    if (/\b(?:hidden|download)(?:\s|=|$)/i.test(attributes)) continue;
    const rel = attributes.match(/(?:^|\s)rel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (rel && decodeEntities(rel[1] ?? rel[2] ?? rel[3]).toLowerCase().split(/\s+/).includes('nofollow')) continue;
    const href = attributes.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!href) continue;
    const value = decodeEntities(href[1] ?? href[2] ?? href[3]).trim();
    if (!value || value.startsWith('#')) continue;
    let url;
    try { url = validatePublicUrl(new URL(value, base).href); } catch { continue; }
    if (url.origin !== base.origin || url.search || url.href === base.href) continue;
    if (/\.(?:pdf|png|jpe?g|gif|svg|zip|xml|json|rss|atom|mp[34]|webp)$/i.test(url.pathname)) continue;
    const label = decodeEntities(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    let path;
    try { path = decodeURIComponent(url.pathname).toLowerCase(); } catch { continue; }
    if (/(?:^|\/)(?:log-?in|sign-?in|sign-?out|log-?out|admin|account|checkout|unsubscribe|delete)(?:\/|$)/.test(path)) continue;
    const normalized = `${path} ${label}`.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]+/g, ' ');
    const personMatch = words.length >= 2 && words.every(word => normalized.split(' ').includes(word));
    let score = personMatch ? 100 : 0;
    if (/(?:^|\/)(?:contact(?:-us|-me)?|get-in-touch)(?:\/|$)/.test(path) || /^(?:contact(?: us| me)?|get in touch|say hello)[.!]?$/i.test(label)) score = Math.max(score, 90);
    if (/(?:^|\/)(?:about(?:-us|-me)?|bio|biography)(?:\/|$)/.test(path) || /^(?:about(?: us| me)?|biography)[.!]?$/i.test(label)) score = Math.max(score, 70);
    if (/(?:^|\/)(?:team|our-team|staff|people|leadership|directory|profiles?)(?:\/|$)/.test(path) || /^(?:our )?(?:team|staff|people|leadership|directory)$/i.test(label)) score = Math.max(score, 60);
    if (!score) continue;
    const previous = found.get(url.href);
    if (!previous || score > previous.score) found.set(url.href, { url: url.href, label: label.slice(0, 160), score });
  }
  return [...found.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, 40);
}

// Dependency injection is for deterministic boundary tests. Production always
// uses safeFetch, which checks DNS and pins each network connection.
export async function discoverWebsite({ sourceUrl, supplementalSourceUrls = [], input = {} }, { fetchPage = safeFetch, now = Date.now, wait = sleep, isSourceExcluded = () => false } = {}) {
  const start = validatePublicUrl(sourceUrl);
  if (start.search) throw new Error('Website search starts from a URL without query parameters. Use Single page for a specific query URL.');
  if (!Array.isArray(supplementalSourceUrls) || supplementalSourceUrls.length > MAX_PAGES - 1) throw new Error('Select at most four supplemental public source URLs.');
  // Validate the entire selection before any network access. Selecting one
  // additional public page authorizes that seed and its own bounded same-origin
  // navigation, never arbitrary sibling domains or another seed's redirects.
  const selected = new Map([[start.href, start]]);
  for (const value of supplementalSourceUrls) {
    const url = validatePublicUrl(value);
    if (url.search) throw new Error('Supplemental website sources must not contain query parameters. Use Single page for a specific query URL.');
    if (!selected.has(url.href)) selected.set(url.href, url);
  }
  const seeds = [...selected.values()].map(url => ({ url: url.href, allowedOrigins: canonicalOrigins(url), origin: null }));
  const deadline = now() + MAX_DURATION_MS;
  const coverage = { startedFrom: start.href, maxPages: MAX_PAGES, pages: [], warnings: [], stopReason: 'finished', robots: [] };
  if (supplementalSourceUrls.length) {
    coverage.selectedSourceUrls = seeds.map(seed => seed.url);
    coverage.sourceSelection = 'explicit_public_sources';
  }
  const results = new Map();
  const seen = new Set();
  const queued = new Set(seeds.map(seed => seed.url));
  const policies = new Map();
  const lastRequests = new Map();
  let timedOut = false;
  const queue = seeds.map(seed => ({ url: seed.url, depth: 0, score: 1000, seed }));

  async function policyFor(url) {
    if (policies.has(url.origin)) return policies.get(url.origin);
    const robotsUrl = new URL('/robots.txt', url).href;
    let policy;
    try {
      const allowedOrigins = canonicalOrigins(url);
      const page = await fetchPage(robotsUrl, { allowedOrigins, deadline });
      const finalUrl = validatePublicUrl(page.url);
      if (!allowedOrigins.includes(finalUrl.origin) || finalUrl.search) throw blocked('Robots access rules left the selected website and were blocked.');
      policy = parseRobots(page.text);
      coverage.robots.push({ url: finalUrl.href, status: 'read', observedAt: stamp() });
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        policy = parseRobots('');
        coverage.robots.push({ url: robotsUrl, status: 'not_found', observedAt: stamp() });
      } else {
        coverage.robots.push({ url: robotsUrl, status: 'error', error: error.message, observedAt: stamp() });
        policy = { isAllowed: () => false, crawlDelayMs: 0, error: 'Could not establish robots.txt access rules. This website was not scanned.' };
      }
    }
    lastRequests.set(url.origin, now());
    policies.set(url.origin, policy);
    return policy;
  }

  async function beforeRequest(url) {
    if (isSourceExcluded(url.href)) throw blocked('This public source is excluded across the workspace.');
    if (url.search) throw blocked('A redirect added query parameters and was not followed.');
    const policy = await policyFor(url);
    if (policy.error) throw blocked(policy.error);
    if (!policy.isAllowed(url)) throw blocked('The website’s robots.txt excludes this path from automated access.');
    const delay = Math.max(250, policy.crawlDelayMs || 0);
    const remaining = Math.max(0, (lastRequests.get(url.origin) || 0) + delay - now());
    if (!Number.isFinite(remaining) || now() + remaining >= deadline) { timedOut = true; throw blocked('The site’s crawl delay exceeds this search’s remaining time budget.'); }
    if (remaining) await wait(remaining);
    if (now() >= deadline) { timedOut = true; throw blocked('The website search time limit was reached.'); }
    lastRequests.set(url.origin, now());
  }

  while (queue.length && coverage.pages.length < MAX_PAGES) {
    if (now() >= deadline) { timedOut = true; break; }
    const candidate = queue.shift();
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const entry = { url: candidate.url, status: 'read', emailCount: 0, observedAt: stamp() };
    coverage.pages.push(entry);
    try {
      if (isSourceExcluded(candidate.url)) throw blocked('This public source is excluded across the workspace.');
      const allowedOrigins = candidate.depth === 0 ? candidate.seed.allowedOrigins : [candidate.seed.origin];
      const page = await fetchPage(candidate.url, { allowedOrigins, beforeRequest: async url => {
        if (url.href !== candidate.url && seen.has(url.href)) throw Object.assign(new Error('This page was already checked through another URL.'), { duplicate: true, url: url.href });
        await beforeRequest(url);
      }, deadline });
      // Also validate adapter output; tests and future adapters cannot expand scope.
      const finalUrl = validatePublicUrl(page.url);
      if (isSourceExcluded(finalUrl.href)) throw blocked('This public source is excluded across the workspace.');
      if (!allowedOrigins.includes(finalUrl.origin) || finalUrl.search) throw blocked('The page left the selected website and was blocked.');
      if (!candidate.seed.origin) candidate.seed.origin = finalUrl.origin;
      entry.url = finalUrl.href;
      entry.observedAt = stamp();
      if (seen.has(finalUrl.href) && finalUrl.href !== candidate.url) { entry.status = 'duplicate'; continue; }
      seen.add(finalUrl.href);
      const contentHash = createHash('sha256').update(page.text).digest('hex');
      const contentBytes = Buffer.byteLength(page.text);
      entry.contentHash = contentHash;
      entry.contentBytes = contentBytes;
      const html = page.contentType !== 'text/plain';
      const publication = publicPageMetadata(page.text, { html });
      Object.assign(entry, publication);
      const candidates = extractEmails(page.text, { html, name: input.name });
      entry.emailCount = candidates.length;
      for (const email of candidates) {
        const source = { url: finalUrl.href, observedAt: entry.observedAt, context: email.context, quoteKind: email.quoteKind,
          associationEvidence: email.associationEvidence, contentHash, contentBytes, ...publication };
        const existing = results.get(email.email);
        if (existing) {
          if (!existing.sources.some(item => item.url === source.url)) existing.sources.push(source);
          existing.flags = [...new Set([...existing.flags, ...email.flags])];
          // Prefer an observed nearby name for display without discarding the
          // earlier unrelated observation or asserting that the address belongs
          // to the person. Human association review is still required.
          if (email.associationEvidence?.state === 'name_near_email' && existing.associationEvidence?.state !== 'name_near_email') {
            existing.associationEvidence = email.associationEvidence;
            existing.context = email.context;
            existing.quoteKind = email.quoteKind;
          }
          if (existing.associationEvidence?.state === 'name_near_email') existing.flags = existing.flags.filter(flag => flag !== 'person_context_not_located');
          continue;
        }
        if (results.size >= MAX_RESULTS) { if (!coverage.warnings.includes('Results are limited to 50 unique emails.')) coverage.warnings.push('Results are limited to 50 unique emails.'); continue; }
        results.set(email.email, { id: randomUUID(), ...email, sourceType: 'public_page', sources: [source], ownership: 'unreviewed', deliverability: 'unknown', verificationAt: null, date: entry.observedAt, review: 'pending' });
      }
      if (candidate.depth < MAX_DEPTH && page.contentType !== 'text/plain') {
        for (const link of contactLinks(page.text, finalUrl.href, input.name)) {
          if (queued.has(link.url) || seen.has(link.url)) continue;
          queued.add(link.url);
          queue.push({ ...link, depth: candidate.depth + 1, seed: candidate.seed });
        }
        queue.sort((a, b) => b.score - a.score || a.depth - b.depth);
      }
    } catch (error) {
      entry.status = error.duplicate ? 'duplicate' : error.blocked || /blocked|excludes|private|reserved|LinkedIn/i.test(error.message) ? 'blocked' : 'error';
      if (error.duplicate) entry.url = error.url;
      entry.error = error.message;
      if (now() >= deadline || /time limit/.test(error.message)) timedOut = true;
    }
  }
  coverage.stopReason = timedOut ? 'time_limit' : queue.some(item => !seen.has(item.url)) ? 'max_pages' : 'finished';
  if (coverage.pages.some(page => ['error', 'blocked'].includes(page.status))) coverage.warnings.push('Some pages could not be checked. These results cover only the pages successfully read.');
  if (coverage.stopReason !== 'finished') coverage.warnings.push('The search stopped at its page or time limit; other contact pages may exist.');
  return { results: [...results.values()], coverage };
}
