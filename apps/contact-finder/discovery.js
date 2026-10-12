import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 50;
const SHARED_LOCALS = new Set(['info', 'contact', 'hello', 'support', 'sales', 'office', 'admin', 'help', 'reception', 'appointments', 'careers', 'jobs', 'hr', 'team', 'enquiries', 'inquiries', 'billing', 'press', 'marketing', 'recruiting', 'recruitment', 'noreply', 'no-reply']);
const ASSET_SUFFIXES = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'css', 'js', 'woff', 'woff2', 'ttf', 'map', 'pdf']);
const PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.invalid', 'yourdomain.com', 'your-domain.com']);

function ipv6Words(address) {
  if (!address.includes(':') || address.includes('%')) return null;
  let expanded = address.toLowerCase();
  if (expanded.includes('.')) {
    const colon = expanded.lastIndexOf(':');
    const v4 = expanded.slice(colon + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    expanded = `${expanded.slice(0, colon)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = expanded.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return words.length === 8 && words.every(w => /^[0-9a-f]{1,4}$/.test(w)) ? words.map(w => parseInt(w, 16)) : null;
}

// Be deliberately conservative with special-purpose addresses. Every DNS answer
// must pass; checking just the first answer leaves a DNS-rebinding/IPv6 gap.
export function isPublicIp(address) {
  const normalized = String(address).replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(normalized) !== 6) return false;
  const w = ipv6Words(normalized);
  if (!w || (w[0] & 0xe000) !== 0x2000) return false;
  // Exclude special-use 2001::/23, documentation ranges, and 6to4 (which can
  // tunnel to private IPv4). This also excludes all IPv4-mapped addresses.
  return !((w[0] === 0x2001 && w[1] < 0x0200) ||
    (w[0] === 0x2001 && w[1] === 0x0db8) || w[0] === 0x2002 ||
    (w[0] === 0x3fff && w[1] < 0x1000));
}

function parseUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error('Enter a complete http:// or https:// source URL.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete http:// or https:// source URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Source URLs must use HTTP or HTTPS and cannot contain credentials.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Only public websites on ports 80 and 443 are supported.');
  url.hash = '';
  return url;
}

export function validatePublicUrl(value) {
  const url = parseUrl(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com') || host === 'lnkd.in' || host.endsWith('.lnkd.in')) {
    throw new Error('LinkedIn pages are not fetched. Use a public professional website, or paste text you are permitted to use.');
  }
  if (!host.includes('.') && !isIP(host) || host === 'localhost' || /\.(localhost|local|internal|lan|home|test|invalid)$/.test(host) || (isIP(host) && !isPublicIp(host))) {
    throw new Error('The source must be a public website; private, local, and reserved addresses are blocked.');
  }
  return url;
}

export function sanitizeSourceUrl(value) {
  if (!value) return null;
  const url = parseUrl(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(api[-_]?key|access[-_]?token|token|password|secret|authorization)$/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

async function beforeDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The source did not respond within 15 seconds. Try a different public page.')), Math.max(1, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

async function publicAddresses(url, lookupImpl, deadline) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
  let addresses;
  try { addresses = await beforeDeadline(lookupImpl(hostname, { all: true, verbatim: true }), deadline); }
  catch (error) {
    if (error.message?.includes('15 seconds')) throw error;
    throw new Error('The website address could not be resolved. Check the URL and try again.');
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(a => !isPublicIp(a.address) || isIP(a.address) !== a.family)) {
    throw new Error('The website resolves to a private, local, reserved, or unsupported address and was blocked.');
  }
  return addresses;
}

function requestPage(url, address, deadline, requestImpl) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    let request;
    const settle = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) { reject(error); request?.destroy(); } else resolve(value);
    };
    const lookup = (_hostname, options, callback) => {
      if (options?.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    const perform = requestImpl || (url.protocol === 'https:' ? https.request : http.request);
    try {
      request = perform(url, {
        method: 'GET', agent: false, family: address.family, lookup,
        headers: { Accept: 'text/html,application/xhtml+xml,text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'LocalLeadFinder/0.1 (single-page public contact lookup)' },
      }, response => {
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location) return settle(new Error('The website returned a redirect without a destination.'));
          return settle(null, { redirect: location });
        }
        if (!status || status < 200 || status >= 300) {
          response.destroy();
          return settle(Object.assign(new Error(`The website returned HTTP ${Number.isInteger(status) ? status : 'error'}. It may require sign-in or block automated requests.`), { statusCode: status }));
        }
        const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType)) {
          response.destroy();
          return settle(new Error('The source must return an HTML or plain-text page. PDFs, images, and downloads are not supported.'));
        }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.destroy();
          return settle(new Error('The website returned unsupported compressed content. Paste its visible text instead.'));
        }
        if (Number(response.headers['content-length']) > MAX_BYTES) {
          response.destroy();
          return settle(new Error('The page exceeds the 2 MB size limit. Use a smaller contact page or paste a relevant excerpt.'));
        }
        let size = 0;
        const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy();
            return settle(new Error('The page exceeds the 2 MB size limit. Use a smaller contact page or paste a relevant excerpt.'));
          }
          chunks.push(chunk);
        });
        response.on('end', () => settle(null, { text: Buffer.concat(chunks).toString('utf8'), contentType }));
        response.on('error', () => settle(new Error('The website connection ended before the page could be read.')));
        response.on('aborted', () => settle(new Error('The website connection ended before the page could be read.')));
      });
      request.on('error', () => settle(new Error('The public page could not be fetched securely. Check the URL or paste its visible text.')));
      timer = setTimeout(() => settle(new Error('The source did not respond within 15 seconds. Try a different public page.')), Math.max(1, deadline - Date.now()));
      request.end();
    } catch {
      settle(new Error('The public page could not be fetched securely. Check the URL or paste its visible text.'));
    }
  });
}

// Native requests pin the connection to a DNS answer already checked above.
// Each redirect repeats URL and DNS checks; no cookies or authorization follow.
export async function safeFetch(sourceUrl, { lookupImpl = dnsLookup, requestImpl, allowedOrigins, beforeRequest, deadline: outerDeadline } = {}) {
  const deadline = Math.min(Date.now() + TIMEOUT_MS, outerDeadline ?? Infinity);
  let url = validatePublicUrl(sourceUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (Date.now() >= deadline) throw new Error('The website search time limit was reached.');
    if (allowedOrigins && !allowedOrigins.includes(url.origin)) throw new Error('A redirect left the selected website and was blocked.');
    if (beforeRequest) await beforeRequest(url);
    const addresses = await publicAddresses(url, lookupImpl, deadline);
    const result = await requestPage(url, addresses[0], deadline, requestImpl);
    if (!result.redirect) return { ...result, url: sanitizeSourceUrl(url.href) };
    if (redirects === 3) throw new Error('The source redirected more than three times. Use its final public page URL.');
    let next;
    try { next = new URL(result.redirect, url).href; } catch { throw new Error('The website returned an invalid redirect destination.'); }
    const nextUrl = validatePublicUrl(next);
    if (allowedOrigins && url.protocol === 'https:' && nextUrl.protocol === 'http:') throw new Error('An insecure redirect was blocked.');
    url = nextUrl;
  }
}

export function decodeEntities(text) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', commat: '@', period: '.', colon: ':', sol: '/', percnt: '%', tab: '\t', newline: '\n' };
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (original, entity) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? original;
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : original;
  });
}

function decodePercent(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

export function isPlausibleEmail(email) {
  if (typeof email !== 'string' || email.length > 254) return false;
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (local.length > 64 || !local || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) return false;
  if (PLACEHOLDER_DOMAINS.has(domain) || ASSET_SUFFIXES.has(domain.split('.').at(-1))) return false;
  return true;
}

export function extractEmails(content, { html = false } = {}) {
  const source = String(content || '');
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) throw new Error('Source text exceeds the 2 MB size limit. Paste a smaller excerpt.');
  const withoutHidden = html ? source.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ') : source;
  const mailtos = [];
  if (html) {
    for (const match of withoutHidden.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const href = decodeEntities(match[1] ?? match[2] ?? match[3]);
      if (/^mailto:/i.test(href.trim())) mailtos.push(decodePercent(href.trim().slice(7).split('?')[0]));
    }
  }
  const visible = decodePercent(decodeEntities(html ? withoutHidden.replace(/<![^>]*>|<\/?[a-z][a-z0-9:-]*(?=[\s/>])[^>]*>/gi, ' ') : withoutHidden)).replace(/\s+/g, ' ').trim();
  const matches = new Map();
  const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}/gi;
  for (const [text, linked] of [[visible, false], ...mailtos.map(value => [value, true])]) {
    for (const match of text.matchAll(emailPattern)) {
      const email = match[0].toLowerCase();
      if (!isPlausibleEmail(email) || matches.has(email)) continue;
      // Do not accept a prefix cut out of an otherwise invalid address/token.
      const after = text[match.index + match[0].length];
      if (after && /[a-z0-9_@-]/i.test(after)) continue;
      if (after === '.' && /[a-z0-9_@-]/i.test(text[match.index + match[0].length + 1] || '')) continue;
      if (text[match.index - 1] === '@' || email.startsWith('//')) continue;
      const start = Math.max(0, match.index - 100);
      const end = Math.min(text.length, match.index + match[0].length + 140);
      const context = linked ? `Email link on source page: ${email}` : `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
      const flags = [];
      if (SHARED_LOCALS.has(email.split('@')[0])) flags.push('shared_mailbox');
      matches.set(email, { email, context, flags });
      if (matches.size === MAX_RESULTS) return [...matches.values()];
    }
  }
  return [...matches.values()];
}

export async function discover({ mode, sourceUrl, sourceText } = {}) {
  let content;
  let url;
  let sourceType;
  let html = false;
  if (mode === 'public') {
    const page = await safeFetch(sourceUrl);
    content = page.text;
    url = page.url;
    html = page.contentType !== 'text/plain';
    sourceType = 'public_page';
  } else if (mode === 'paste') {
    if (typeof sourceText !== 'string' || !sourceText.trim()) throw new Error('Paste public or authorized source text containing the contact information.');
    content = sourceText;
    url = sanitizeSourceUrl(sourceUrl);
    sourceType = 'pasted_text';
    html = /<\/?(?:html|body|div|span|p|a|table|script|style|template)(?=[\s/>])[^>]*>/i.test(content);
  } else {
    throw new Error('Choose public-page lookup or pasted source text. Provider enrichment is disabled.');
  }
  const observedAt = new Date().toISOString();
  return extractEmails(content, { html }).map(candidate => ({
    id: randomUUID(), ...candidate, sourceType,
    sources: url ? [{ url, observedAt }] : [],
    ownership: 'unreviewed', deliverability: 'unknown', verificationAt: null,
    date: observedAt, review: 'pending',
    flags: [...candidate.flags, ...(sourceType === 'pasted_text' ? ['user_supplied_source_text'] : []), ...(!url ? ['missing_source_url'] : [])],
  }));
}
