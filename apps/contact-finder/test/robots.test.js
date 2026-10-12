import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots } from '../robots.js';

const url = path => `https://clinic.org${path}`;

test('missing text and unmatched agents allow; malformed URLs fail closed', () => {
  for (const text of [undefined, null, '', '# comment', 'Disallow: /', 'User-agent: OtherBot\nDisallow: /']) {
    const policy = parseRobots(text);
    assert.equal(policy.isAllowed(url('/team')), true);
    assert.equal(policy.crawlDelayMs, 0);
    assert.equal(policy.isAllowed('/relative'), false);
  }
});

test('longest agent token wins case-insensitively; wildcard is fallback only', () => {
  const text = `User-agent: *\nDisallow: /wild\nCrawl-delay: 50
    User-agent: Lead\nDisallow: /short\nCrawl-delay: 30
    User-agent: LOCALLEADFINDER\nDisallow: /specific\nCrawl-delay: 0.5`;
  const specific = parseRobots(text, 'LocalLeadFinder/1.0');
  assert.equal(specific.isAllowed(url('/specific')), false);
  assert.equal(specific.isAllowed(url('/short')), true);
  assert.equal(specific.isAllowed(url('/wild')), true);
  assert.equal(specific.crawlDelayMs, 500);
  const fallback = parseRobots(text, 'DifferentBot');
  assert.equal(fallback.isAllowed(url('/wild')), false);
  assert.equal(fallback.isAllowed(url('/specific')), true);
  assert.equal(fallback.crawlDelayMs, 50_000);
});

test('duplicate and equally specific groups merge; multiple agent lines share rules', () => {
  const policy = parseRobots(`User-agent: LocalLeadFinder
    User-agent: OtherBot
    Disallow: /one
    User-agent: localleadfinder
    Disallow: /two
    Allow: /one/public
    Crawl-delay: 2
    User-agent: LOCALLEADFINDER
    Disallow: /three
    Crawl-delay: 3.25`);
  for (const path of ['/one', '/two', '/three']) assert.equal(policy.isAllowed(url(path)), false, path);
  assert.equal(policy.isAllowed(url('/one/public')), true);
  assert.equal(policy.crawlDelayMs, 3250);
  const equallySpecific = parseRobots('User-agent: Local\nDisallow: /local\nUser-agent: LeadF\nDisallow: /lead');
  assert.equal(equallySpecific.isAllowed(url('/local')), false);
  assert.equal(equallySpecific.isAllowed(url('/lead')), false);
});

test('longest path wins; equivalent allow wins regardless of record order', () => {
  for (const lines of ['Disallow: /same\nAllow: /same', 'Allow: /same\nDisallow: /same']) {
    const policy = parseRobots(`User-agent: *\nDisallow: /\nAllow: /public\nDisallow: /public/private\n${lines}`);
    assert.equal(policy.isAllowed(url('/unknown')), false);
    assert.equal(policy.isAllowed(url('/public/team')), true);
    assert.equal(policy.isAllowed(url('/public/private/notes')), false);
    assert.equal(policy.isAllowed(url('/same')), true);
    assert.equal(policy.isAllowed(url('/robots.txt')), true);
  }
});

test('wildcards match zero or more characters; trailing dollar anchors the full path and query', () => {
  const policy = parseRobots(`User-agent: *
    Disallow: /private/*/person$
    Disallow: *.pdf$
    Disallow: /team$`);
  for (const path of ['/private//person', '/private/a/b/person', '/report.pdf', '/team']) assert.equal(policy.isAllowed(url(path)), false, path);
  for (const path of ['/private/a/person/next', '/report.pdf?download=1', '/team?view=all', '/teammates']) assert.equal(policy.isAllowed(url(path)), true, path);
  assert.equal(parseRobots('User-agent: *\nDisallow: /*repeat$').isAllowed(url('/repeat-repeat')), false);
});

test('queries participate in matching; fragments do not, and paths remain case-sensitive', () => {
  const policy = parseRobots('User-agent: *\nDisallow: /staff?private=1\nDisallow: /Team$');
  assert.equal(policy.isAllowed(new URL(url('/staff?private=1&next=2'))), false);
  assert.equal(policy.isAllowed(url('/staff?private=2')), true);
  assert.equal(policy.isAllowed(url('/Team#profile')), false);
  assert.equal(policy.isAllowed(url('/team')), true);
});

test('unreserved percent encoding and UTF-8 normalize; reserved encoded delimiters stay distinct', () => {
  const policy = parseRobots(`User-agent: *
    Disallow: /%73taff/~person$
    Disallow: /caf\u00e9$
    Disallow: /%e3%83%84$
    Disallow: /encoded%2fpath$
    Disallow: /literal%2A$
    Disallow: /literal%24$`);
  for (const path of ['/staff/%7eperson', '/caf%C3%A9', '/caf\u00e9', '/\u30c4', '/%e3%83%84', '/encoded%2Fpath', '/literal*', '/literal%2a', '/literal$', '/literal%24']) assert.equal(policy.isAllowed(url(path)), false, path);
  for (const path of ['/encoded/path', '/literal-anything']) assert.equal(policy.isAllowed(url(path)), true, path);
  const tie = parseRobots('User-agent: *\nDisallow: /caf%C3%A9\nAllow: /caf\u00e9$');
  assert.equal(tie.isAllowed(url('/caf\u00e9')), true);
});

test('comments, empty directives and unknown fields do not corrupt groups', () => {
  const policy = parseRobots(`\uFEFFDisallow: /
    USER-AGENT: LocalLeadFinder # crawler
    Sitemap: https://clinic.org/sitemap.xml
    User-agent: OtherBot
    Disallow: # empty disallow
    Allow:
    Unsupported: anything
    Disallow: /blocked # staff private
    Disallow: /hash%23value
    User-agent: LastBot
    Disallow: /`);
  assert.equal(policy.isAllowed(url('/team')), true);
  assert.equal(policy.isAllowed(url('/blocked')), false);
  assert.equal(policy.isAllowed(url('/hash%23value')), false);
  const emptySpecific = parseRobots('User-agent: *\nDisallow: /\nUser-agent: LocalLeadFinder');
  assert.equal(emptySpecific.isAllowed(url('/team')), true);
});

test('crawl-delay preserves conservative maximum and large directives without silently clamping', () => {
  const policy = parseRobots('User-agent: *\nCrawl-delay: 3600\nCrawl-delay: 0.25\nCrawl-delay: invalid\nCrawl-delay: -1');
  assert.equal(policy.crawlDelayMs, 3_600_000);
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: .0001').crawlDelayMs, 1);
  assert.equal(parseRobots('User-agent: *\nCrawl-delay: ' + '9'.repeat(400)).crawlDelayMs, Infinity);
});

test('wildcard-rich nonmatches complete without regex backtracking', () => {
  const policy = parseRobots('User-agent: *\nDisallow: /' + '*a'.repeat(500) + '*b$');
  assert.equal(policy.isAllowed(url('/' + 'a'.repeat(10_000))), true);
});
