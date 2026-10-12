import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { contactLinks, discoverWebsite } from '../website-discovery.js';
import { safeFetch } from '../discovery.js';

const origin = 'https://clinic.org';

// Model the same pre-request boundary as safeFetch; fixtures are synthetic and
// never contact the network or the user's persisted contact database.
function websiteFixture(pages, { robots = '', start = 1_000, elapsedPerPage = 0 } = {}) {
  let clock = start;
  const calls = [];
  const attempts = [];
  const waits = [];
  const options = {
    now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; },
    fetchPage: async (value, opts = {}) => {
      const url = new URL(value);
      attempts.push(url.href);
      if (opts.allowedOrigins && !opts.allowedOrigins.includes(url.origin)) throw new Error('Origin blocked by fixture.');
      if (opts.beforeRequest) await opts.beforeRequest(url);
      calls.push(url.href);
      if (url.pathname === '/robots.txt') {
        const policy = typeof robots === 'function' ? robots(url) : robots;
        if (policy instanceof Error) throw policy;
        return { url: url.href, text: policy, contentType: 'text/plain' };
      }
      clock += elapsedPerPage;
      const page = pages[url.href] ?? pages[url.pathname];
      if (page instanceof Error) throw page;
      assert.notEqual(page, undefined, `Unexpected page request ${url.href}`);
      return typeof page === 'string'
        ? { url: url.href, text: page, contentType: 'text/html' }
        : { url: url.href, contentType: 'text/html', ...page };
    },
  };
  return { options, calls, attempts, waits };
}

test('website link selection ranks the named person and rejects off-site, hidden, query, asset and action links', () => {
  const html = `<base href="https://unrelated.org/">
    <a href="/contact">Contact</a><a href="/directory/jane-doe">Jane Doe</a>
    <a href="/about#bio">About</a><a href="/team">Our team</a>
    <a href="https://other.org/contact">Contact</a><a href="http://clinic.org/contact">Contact</a>
    <a href="https://www.linkedin.com/in/jane">Jane Doe</a><a href="/search?q=Jane">Jane Doe</a>
    <a href="mailto:jane@clinic.org">Jane Doe</a><a href="/jane-doe.pdf">Jane Doe</a>
    <a href="/account/contact">Contact</a><a href="/delete/jane-doe">Jane Doe</a>
    <a href="/other" hidden>Jane Doe</a><a href="/download" download>Jane Doe</a>
    <a href="/nofollow" rel="nofollow">Jane Doe</a><a href="/nofollow-unquoted" rel=nofollow>Jane Doe</a>
    <script><a href="/script-contact">Contact</a></script>
    <template><a href="/template-contact">Contact</a></template>
    <!-- <a href="/comment-contact">Contact</a> -->
    <a href="/blog/about-the-business">A post about the business</a>
    <a href="#top">Contact</a><a href="/">Contact</a>`;
  const links = contactLinks(html, `${origin}/`, 'Jane Doe');
  assert.deepEqual(links.map(link => link.url), [
    `${origin}/directory/jane-doe`, `${origin}/contact`, `${origin}/about`, `${origin}/team`,
  ]);
  assert.equal(links[0].score, 100);
});

test('website discovery finds a linked public profile and retains unknown ownership and deliverability', async () => {
  const h = websiteFixture({
    '/': '<h1>Clinic</h1><a href="/team">Our team</a>',
    '/team': '<a href="/people/jane-doe">Jane Doe</a>',
    '/people/jane-doe': '<h1>Jane Doe, public professional contact</h1><p>jane@clinic.org</p>',
  });
  const result = await discoverWebsite({ sourceUrl: `${origin}/`, input: { name: 'Jane Doe' } }, h.options);
  assert.deepEqual(h.calls, [`${origin}/robots.txt`, `${origin}/`, `${origin}/team`, `${origin}/people/jane-doe`]);
  assert.equal(result.results.length, 1);
  const contact = result.results[0];
  assert.equal(contact.email, 'jane@clinic.org');
  assert.equal(contact.ownership, 'unreviewed');
  assert.equal(contact.deliverability, 'unknown');
  assert.equal(contact.review, 'pending');
  assert.equal(contact.verificationAt, null);
  assert.equal(contact.sources[0].url, `${origin}/people/jane-doe`);
  assert.match(contact.sources[0].context, /Jane Doe/);
  assert.ok(Date.parse(contact.sources[0].observedAt));
  assert.equal(result.coverage.stopReason, 'finished');
  assert.deepEqual(result.coverage.pages.map(page => page.emailCount), [0, 0, 1]);
  assert.ok(h.waits.every(ms => ms >= 250));
});

test('same email on two pages merges distinct source snippets without asserting a person match', async () => {
  const h = websiteFixture({
    '/': '<p>Reception: info@clinic.org</p><a href="/contact">Contact</a>',
    '/contact': '<p>Our main office: INFO@clinic.org</p>',
  });
  const { results } = await discoverWebsite({ sourceUrl: `${origin}/`, input: { name: 'Jane Doe' } }, h.options);
  assert.equal(results.length, 1);
  assert.equal(results[0].sources.length, 2);
  assert.deepEqual(results[0].sources.map(source => source.url), [`${origin}/`, `${origin}/contact`]);
  assert.match(results[0].sources[0].context, /Reception/);
  assert.match(results[0].sources[1].context, /main office/);
  assert.ok(results[0].flags.includes('shared_mailbox'));
  assert.equal(results[0].ownership, 'unreviewed');
});

test('website search never guesses addresses from a name, employer, or social handle', async () => {
  const h = websiteFixture({ '/': '<h1>Jane Doe</h1><p>Clinic</p><p>@jane@social.clinic.org</p><a href="https://social.clinic.org/@jane@social.clinic.org">Follow Jane</a>' });
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, input: { name: 'Jane Doe', domain: 'clinic.org' } }, h.options);
  assert.deepEqual(results, []);
  assert.equal(coverage.pages.length, 1);
  assert.deepEqual(h.calls, [`${origin}/robots.txt`, `${origin}/`]);
});

test('website search counts failed page attempts against its five-page limit', async () => {
  const pages = { '/': Array.from({ length: 9 }, (_, i) => `<a href="/team/${i}">Staff</a>`).join('') };
  for (let i = 0; i < 9; i++) pages[`/team/${i}`] = new Error('HTTP 503');
  const h = websiteFixture(pages);
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/` }, h.options);
  assert.deepEqual(results, []);
  assert.equal(coverage.pages.length, 5);
  assert.equal(coverage.pages.filter(page => page.status === 'error').length, 4);
  assert.equal(h.calls.filter(url => !url.endsWith('/robots.txt')).length, 5);
  assert.equal(coverage.stopReason, 'max_pages');
  assert.ok(coverage.warnings.some(warning => /could not be checked/.test(warning)));
});

test('website search stops at link depth two and deduplicates observed links', async () => {
  const h = websiteFixture({
    '/': '<a href="/team">Staff</a><a href="/team#all">Our team</a>',
    '/team': '<a href="/people/jane">Jane Doe</a><a href="/">Contact</a>',
    '/people/jane': '<a href="/people/jane/contact">Contact</a>',
  });
  const { coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, input: { name: 'Jane Doe' } }, h.options);
  assert.deepEqual(h.calls.filter(url => !url.endsWith('/robots.txt')), [`${origin}/`, `${origin}/team`, `${origin}/people/jane`]);
  assert.equal(coverage.stopReason, 'finished');
});

test('robots-disallowed paths are recorded but never requested', async () => {
  const h = websiteFixture({ '/': '<a href="/team/private">Staff</a><a href="/contact">Contact</a>', '/contact': 'office@clinic.org' }, {
    robots: 'User-agent: *\nDisallow: /team/private',
  });
  const { coverage } = await discoverWebsite({ sourceUrl: `${origin}/` }, h.options);
  assert.equal(h.calls.includes(`${origin}/team/private`), false);
  const denied = coverage.pages.find(page => page.url === `${origin}/team/private`);
  assert.equal(denied.status, 'blocked');
  assert.match(denied.error, /robots/);
});

test('unavailable robots fails closed, while a 404 permits the selected page', async () => {
  const blocked = websiteFixture({ '/': 'jane@clinic.org' }, { robots: new Error('Connection failed') });
  const failure = await discoverWebsite({ sourceUrl: `${origin}/` }, blocked.options);
  assert.deepEqual(failure.results, []);
  assert.deepEqual(blocked.calls, [`${origin}/robots.txt`]);
  assert.equal(failure.coverage.pages[0].status, 'blocked');
  assert.equal(failure.coverage.robots[0].status, 'error');
  const absent = websiteFixture({ '/': 'jane@clinic.org' }, { robots: Object.assign(new Error('HTTP 404'), { statusCode: 404 }) });
  const success = await discoverWebsite({ sourceUrl: `${origin}/` }, absent.options);
  assert.equal(success.results.length, 1);
  assert.equal(success.coverage.robots[0].status, 'not_found');
});

test('crawl delay beyond the total search budget stops without reading the page', async () => {
  const h = websiteFixture({ '/': 'jane@clinic.org' }, { robots: 'User-agent: *\nCrawl-delay: 60' });
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/` }, h.options);
  assert.deepEqual(results, []);
  assert.deepEqual(h.calls, [`${origin}/robots.txt`]);
  assert.equal(coverage.stopReason, 'time_limit');
  assert.equal(coverage.pages[0].status, 'blocked');
});

test('total elapsed budget stops subsequent content requests and reports incomplete coverage', async () => {
  const h = websiteFixture({ '/': '<a href="/contact">Contact</a>', '/contact': 'jane@clinic.org' }, { elapsedPerPage: 45_000 });
  const { coverage } = await discoverWebsite({ sourceUrl: `${origin}/` }, h.options);
  assert.equal(coverage.pages.length, 1);
  assert.equal(coverage.stopReason, 'time_limit');
  assert.equal(h.calls.includes(`${origin}/contact`), false);
});

test('query-bearing, LinkedIn and private seeds fail before any fetch', async () => {
  for (const sourceUrl of ['https://clinic.org/?token=private', 'https://linkedin.com/in/jane', 'http://127.0.0.1/contact']) {
    const h = websiteFixture({});
    await assert.rejects(discoverWebsite({ sourceUrl }, h.options));
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.attempts, []);
  }
});

function redirectingRequest(destination, calls) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      calls.push(url.href);
      const response = new EventEmitter();
      response.destroy = () => {};
      response.statusCode = 302;
      response.headers = { location: destination };
      callback(response);
    });
    return request;
  };
}

test('safeFetch rejects a redirect outside the allowed origin before its DNS lookup or request', async () => {
  const requests = [];
  const dns = [];
  const guards = [];
  await assert.rejects(safeFetch(`${origin}/contact`, {
    allowedOrigins: [origin],
    lookupImpl: async hostname => { dns.push(hostname); return [{ address: '93.184.215.14', family: 4 }]; },
    requestImpl: redirectingRequest('https://other.org/contact', requests),
    beforeRequest: async url => { guards.push(url.href); },
  }), /left.*blocked/);
  assert.deepEqual(requests, [`${origin}/contact`]);
  assert.deepEqual(dns, ['clinic.org']);
  assert.deepEqual(guards, [`${origin}/contact`]);
});

test('safeFetch never follows HTTPS downgrade even when both origins are allowed', async () => {
  const requests = [];
  await assert.rejects(safeFetch(`${origin}/contact`, {
    allowedOrigins: [origin, 'http://clinic.org'],
    lookupImpl: async () => [{ address: '93.184.215.14', family: 4 }],
    requestImpl: redirectingRequest('http://clinic.org/contact', requests),
  }), /insecure.*blocked/);
  assert.equal(requests.length, 1);
});

test('adapter output cannot expand website scope or introduce query parameters', async () => {
  for (const finalUrl of ['https://other.org/contact', 'https://clinic.org/contact?private=value']) {
    const h = websiteFixture({ '/': { url: finalUrl, text: 'jane@clinic.org' } });
    const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/` }, h.options);
    assert.deepEqual(results, []);
    assert.equal(coverage.pages[0].status, 'blocked');
  }
});

test('production fetch boundary consults robots again before following a same-site redirect', async () => {
  const requests = [];
  const routes = {
    [`${origin}/robots.txt`]: { text: 'User-agent: *\nDisallow: /private/' },
    [`${origin}/`]: { status: 302, location: '/private/contact' },
  };
  const requestImpl = (url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      requests.push(url.href);
      const fixture = routes[url.href];
      assert.ok(fixture, `Blocked destination must not be requested: ${url.href}`);
      const response = new EventEmitter();
      response.destroy = () => {};
      response.statusCode = fixture.status ?? 200;
      response.headers = { 'content-type': 'text/plain', ...(fixture.location ? { location: fixture.location } : {}) };
      callback(response);
      if (!fixture.status) { response.emit('data', Buffer.from(fixture.text)); response.emit('end'); }
    });
    return request;
  };
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/` }, {
    wait: async () => {},
    fetchPage: (url, options) => safeFetch(url, {
      ...options, requestImpl, lookupImpl: async () => [{ address: '93.184.215.14', family: 4 }],
    }),
  });
  assert.deepEqual(requests, [`${origin}/robots.txt`, `${origin}/`]);
  assert.deepEqual(results, []);
  assert.equal(coverage.pages[0].status, 'blocked');
  assert.match(coverage.pages[0].error, /robots/);
});
