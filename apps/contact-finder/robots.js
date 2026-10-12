// Parsing/matching subset of RFC 9309: https://www.rfc-editor.org/rfc/rfc9309.html
// Retrieval, caching, HTTP error policy, and origin boundaries belong to the caller.
// Crawl-delay is a nonstandard extension; it is returned without a scheduling cap.
const UNRESERVED = /^[A-Za-z0-9._~-]$/;

function normalizePath(value) {
  let result = '';
  for (let i = 0; i < value.length;) {
    if (value[i] === '%' && /^[0-9a-f]{2}$/i.test(value.slice(i + 1, i + 3))) {
      const hex = value.slice(i + 1, i + 3).toUpperCase();
      const character = String.fromCharCode(parseInt(hex, 16));
      result += UNRESERVED.test(character) ? character : `%${hex}`;
      i += 3;
      continue;
    }
    const character = String.fromCodePoint(value.codePointAt(i));
    i += character.length;
    // Keep URI delimiters distinct from their percent-encoded counterparts.
    // Encode literal REP metacharacters so %2A and %24 can match them verbatim.
    if (character.codePointAt(0) > 127 || character === '*' || character === '$' || character === ' ') {
      result += [...Buffer.from(character)].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    } else {
      result += character;
    }
  }
  return result;
}

function compileRule(value, allow) {
  const exact = value.endsWith('$');
  const pattern = exact ? value.slice(0, -1) : value;
  const parts = pattern.split('*').map(normalizePath);
  // Specificity counts literal octets, excluding wildcard/end operators.
  const specificity = parts.reduce((sum, part) => sum + part.replace(/%[0-9A-F]{2}/g, 'x').length, 0);
  return { parts, exact, specificity, allow };
}

function matchesRule(path, { parts, exact }) {
  if (!path.startsWith(parts[0])) return false;
  if (parts.length === 1) return !exact || path.length === parts[0].length;
  let offset = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    // For an anchored final segment, choose its last position. Earlier wildcard
    // segments use the first available position, leaving the maximum suffix.
    const position = exact && i === parts.length - 1
      ? (path.endsWith(part) ? path.length - part.length : -1)
      : path.indexOf(part, offset);
    if (position < offset) return false;
    offset = position + part.length;
  }
  return true;
}

/**
 * Parse already-fetched UTF-8 robots text for a crawler's product token.
 * Uses the longest case-insensitive matching agent token, merging equally
 * specific groups; '*' applies only when no specific group matches.
 * Paths are case-sensitive and include the query, excluding the fragment.
 * Unknown records are ignored. Invalid URL inputs fail closed.
 */
export function parseRobots(text = '', userAgent = 'LocalLeadFinder') {
  const groups = [];
  let group;
  for (const rawLine of String(text ?? '').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    const line = rawLine.split('#', 1)[0].trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!/^(?:\*|[a-z0-9_-]+)$/i.test(value)) continue;
      if (!group || group.hasDirectives) {
        group = { agents: [], rules: [], crawlDelayMs: 0, hasDirectives: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (field === 'allow' || field === 'disallow')) {
      group.hasDirectives = true;
      if (value && (value.startsWith('/') || value.startsWith('*')) && !/[\u0000-\u001F\u007F]/.test(value)) {
        group.rules.push(compileRule(value, field === 'allow'));
      }
    } else if (group && field === 'crawl-delay') {
      group.hasDirectives = true;
      if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
        // Overflow means an effectively infinite delay; never turn it into zero.
        group.crawlDelayMs = Math.max(group.crawlDelayMs, Math.ceil(Number(value) * 1000));
      }
    }
  }

  const agent = String(userAgent).toLowerCase();
  const scored = groups.map(group => ({ group, score: group.agents.reduce((best, token) => Math.max(best, token === '*' ? 0 : agent.includes(token) ? token.length : -1), -1) }));
  const best = scored.reduce((best, { score }) => Math.max(best, score), -1);
  const selected = scored.filter(({ score }) => score >= 0 && score === best).map(({ group }) => group);
  const rules = selected.flatMap(group => group.rules);
  const crawlDelayMs = selected.reduce((delay, group) => Math.max(delay, group.crawlDelayMs), 0);
  return {
    crawlDelayMs,
    isAllowed(input) {
      let url;
      try { url = input instanceof URL ? input : new URL(input); } catch { return false; }
      const path = normalizePath(url.pathname + url.search);
      if (url.pathname === '/robots.txt' && !url.search) return true;
      let winner;
      for (const rule of rules) {
        if (matchesRule(path, rule) && (!winner || rule.specificity > winner.specificity || (rule.specificity === winner.specificity && rule.allow))) winner = rule;
      }
      return winner ? winner.allow : true;
    },
  };
}
