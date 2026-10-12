import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
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

test('explicit public supplements run before generic links and preserve independent named source observations', async () => {
  const faculty = 'https://faculty.clinic.org/people/jane-doe';
  const journal = 'https://journal.org/article/jane-doe';
  const facultyText = '<h1>Jane Doe, physician</h1><p>Public professional email: jane@clinic.org</p>';
  const journalText = '<h1>Research article</h1><p>Correspondence to Jane Doe: JANE@clinic.org</p>';
  const h = websiteFixture({
    [`${origin}/`]: '<h1>Clinical directory</h1><p>Office: info@clinic.org</p><a href="/contact">Contact</a>',
    [faculty]: facultyText,
    [journal]: journalText,
    [`${origin}/contact`]: '<p>Department office: office@clinic.org</p>',
  });
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [faculty, journal], input: { name: 'Jane Doe' } }, h.options);
  assert.deepEqual(h.calls.filter(url => !url.endsWith('/robots.txt')), [`${origin}/`, faculty, journal, `${origin}/contact`]);
  assert.deepEqual(coverage.selectedSourceUrls, [`${origin}/`, faculty, journal]);
  assert.equal(coverage.sourceSelection, 'explicit_public_sources');
  const email = results.find(row => row.email === 'jane@clinic.org');
  assert.ok(email, 'The selected faculty and publisher observations must be read, not omitted');
  assert.deepEqual(email.sources.map(source => source.url), [faculty, journal]);
  for (const [index, text] of [facultyText, journalText].entries()) {
    const source = email.sources[index];
    assert.match(source.context, /Jane Doe/);
    assert.equal(source.contentHash, createHash('sha256').update(text).digest('hex'));
    assert.equal(source.contentBytes, Buffer.byteLength(text));
    assert.ok(Date.parse(source.observedAt));
    assert.equal(coverage.pages.find(page => page.url === source.url).contentHash, source.contentHash);
  }
  for (const row of results) {
    assert.equal(row.ownership, 'unreviewed');
    assert.equal(row.review, 'pending');
    assert.equal(row.deliverability, 'unknown');
    assert.equal(row.verificationAt, null);
  }
  assert.ok(results.some(row => row.email === 'info@clinic.org'), 'Unrelated source contacts stay observations, not name matches');
});

test('all selected supplements validate before fetching even the valid primary page', async () => {
  const invalidSets = [
    ['https://faculty.clinic.org/jane', 'https://faculty.clinic.org/profile?id=10'],
    ['https://faculty.clinic.org/jane', 'https://user:password@journal.org/contact'],
    ['https://faculty.clinic.org/jane', 'https://linkedin.com/in/jane'],
    ['https://faculty.clinic.org/jane', 'http://127.0.0.1/contact'],
    ['https://faculty.clinic.org/jane', 'http://[::ffff:127.0.0.1]/contact'],
    ['https://faculty.clinic.org/jane', 'https://journal.org:8080/contact'],
    ['https://faculty.clinic.org/jane', 'file:///etc/passwd'],
    ['https://faculty.clinic.org/jane', ''],
    ['https://faculty.clinic.org/jane', 12],
    Array.from({ length: 5 }, (_, index) => `https://faculty.clinic.org/people/${index}`),
    'https://faculty.clinic.org/jane',
    null,
  ];
  for (const supplementalSourceUrls of invalidSets) {
    const h = websiteFixture({ '/': 'info@clinic.org' });
    await assert.rejects(discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls }, h.options));
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.attempts, []);
  }
});

test('empty supplements preserve primary-only navigation and duplicate selected URLs are read once', async () => {
  const faculty = 'https://faculty.clinic.org/jane';
  const h = websiteFixture({ '/': '<p>No published email.</p>', [faculty]: '<p>Jane Doe: jane@clinic.org</p>' });
  const { coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [`${origin}/#same`, faculty, `${faculty}#same`], input: { name: 'Jane Doe' } }, h.options);
  assert.deepEqual(coverage.selectedSourceUrls, [`${origin}/`, faculty]);
  assert.deepEqual(h.calls.filter(url => !url.endsWith('/robots.txt')), [`${origin}/`, faculty]);
  const empty = websiteFixture({ '/': '<a href="/contact">Contact</a>', '/contact': 'office@clinic.org' });
  const result = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [] }, empty.options);
  assert.deepEqual(empty.calls, [`${origin}/robots.txt`, `${origin}/`, `${origin}/contact`]);
  assert.equal(result.coverage.sourceSelection, undefined);
});

test('five selected seeds share one page budget and do not each receive five linked pages', async () => {
  const seeds = [0, 1, 2, 3].map(index => `https://faculty${index}.clinic.org/people/jane`);
  const pages = { [`${origin}/`]: '<a href="/contact">Contact</a>' };
  for (const url of seeds) pages[url] = '<a href="/contact">Contact</a><p>Jane Doe</p>';
  const h = websiteFixture(pages);
  const { coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: seeds }, h.options);
  assert.deepEqual(h.calls.filter(url => !url.endsWith('/robots.txt')), [`${origin}/`, ...seeds]);
  assert.equal(coverage.pages.length, 5);
  assert.equal(coverage.stopReason, 'max_pages');
  assert.ok(coverage.warnings.some(warning => /page or time limit/.test(warning)));
});

test('supplements share the original total duration and cannot reset it per selected source', async () => {
  const faculty = 'https://faculty.clinic.org/jane';
  const h = websiteFixture({ '/': 'No contact', [faculty]: 'Jane Doe: jane@clinic.org' }, { elapsedPerPage: 45_000 });
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [faculty] }, h.options);
  assert.deepEqual(results, []);
  assert.equal(coverage.stopReason, 'time_limit');
  assert.equal(coverage.pages.length, 1);
  assert.equal(h.attempts.includes(faculty), false);
});

test('each selected origin has a separate robots policy and cannot authorize another source', async () => {
  const faculty = 'https://faculty.clinic.org/people/jane';
  const journal = 'https://journal.org/paper';
  const h = websiteFixture({ '/': 'No email', [faculty]: 'Do not read jane@clinic.org', [journal]: 'Jane Doe: jane@clinic.org' }, {
    robots: url => url.origin === 'https://faculty.clinic.org' ? 'User-agent: *\nDisallow: /people/' : '',
  });
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [faculty, journal] }, h.options);
  assert.equal(h.calls.includes(faculty), false);
  assert.equal(coverage.pages.find(page => page.url === faculty).status, 'blocked');
  assert.deepEqual(coverage.robots.map(row => row.url), [`${origin}/robots.txt`, 'https://faculty.clinic.org/robots.txt', 'https://journal.org/robots.txt']);
  assert.deepEqual(results[0].sources.map(source => source.url), [journal]);
});

test('each supplemental seed keeps its own origin for related links and rejects unselected sibling sources', async () => {
  const faculty = 'https://faculty.clinic.org/people/jane';
  const h = websiteFixture({
    '/': '<a href="https://secret.clinic.org/contact">Contact</a>',
    [faculty]: '<a href="/contact">Contact</a><a href="https://secret.clinic.org/people/jane">Jane Doe</a>',
    'https://faculty.clinic.org/contact': 'Jane Doe: jane@clinic.org',
  });
  const { results } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [faculty], input: { name: 'Jane Doe' } }, h.options);
  assert.deepEqual(h.calls.filter(url => !url.endsWith('/robots.txt')), [`${origin}/`, faculty, 'https://faculty.clinic.org/contact']);
  assert.equal(h.attempts.some(url => url.startsWith('https://secret.clinic.org')), false);
  assert.equal(results[0].sources[0].url, 'https://faculty.clinic.org/contact');
});

test('duplicate selected origins fetch robots once while preserving separate page observations', async () => {
  const pages = { '/': 'No email', '/people/jane': 'Jane Doe: jane@clinic.org', '/team/jane': 'Jane Doe: jane@clinic.org' };
  const h = websiteFixture(pages);
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [`${origin}/people/jane`, `${origin}/team/jane`] }, h.options);
  assert.equal(h.calls.filter(url => url === `${origin}/robots.txt`).length, 1);
  assert.equal(coverage.robots.length, 1);
  assert.equal(results[0].sources.length, 2);
});

test('supplemental adapter output cannot escape to another explicitly selected origin', async () => {
  const faculty = 'https://faculty.clinic.org/people/jane';
  const journal = 'https://journal.org/paper';
  const h = websiteFixture({ '/': 'No email', [faculty]: { url: journal, text: 'Injected jane@clinic.org' }, [journal]: 'No email' });
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [faculty, journal] }, h.options);
  assert.deepEqual(results, []);
  assert.equal(coverage.pages.find(page => page.url === faculty).status, 'blocked');
  assert.match(coverage.pages.find(page => page.url === faculty).error, /blocked/);
});

test('unavailable supplemental robots and off-origin robots adapter output fail closed', async () => {
  const faculty = 'https://faculty.clinic.org/people/jane';
  const unavailable = websiteFixture({ '/': 'No email', [faculty]: 'Jane Doe: jane@clinic.org' }, {
    robots: url => url.origin === 'https://faculty.clinic.org' ? new Error('HTTP 503') : '',
  });
  const blockedResult = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [faculty] }, unavailable.options);
  assert.equal(unavailable.calls.includes(faculty), false);
  assert.equal(blockedResult.coverage.pages[1].status, 'blocked');
  assert.deepEqual(blockedResult.results, []);

  for (const redirectedRobots of ['https://unselected.org/robots.txt', 'https://faculty.clinic.org/robots.txt?token=private']) {
    const h = websiteFixture({ '/': 'No email', [faculty]: 'Jane Doe: jane@clinic.org' });
    const originalFetch = h.options.fetchPage;
    h.options.fetchPage = async (value, options) => value === 'https://faculty.clinic.org/robots.txt'
      ? { url: redirectedRobots, text: '', contentType: 'text/plain' }
      : originalFetch(value, options);
    const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [faculty] }, h.options);
    assert.deepEqual(results, []);
    assert.equal(h.calls.includes(faculty), false);
    assert.equal(coverage.pages[1].status, 'blocked');
  }
});

function nativeWebsiteFixture(routes, addresses = () => [{ address: '93.184.215.14', family: 4 }]) {
  const requests = [];
  const resolutions = [];
  const requestImpl = (url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      requests.push(url.href);
      const page = routes[url.href];
      assert.ok(page, `Denied page must not be requested: ${url.href}`);
      const response = new EventEmitter();
      response.destroy = () => {};
      response.statusCode = page.status ?? 200;
      response.headers = { 'content-type': 'text/plain', ...(page.location ? { location: page.location } : {}) };
      callback(response);
      if (!page.status) { response.emit('data', Buffer.from(page.text)); response.emit('end'); }
    });
    return request;
  };
  return { requests, resolutions, options: {
    wait: async () => {},
    fetchPage: (url, options) => safeFetch(url, {
      ...options, requestImpl, lookupImpl: async hostname => { resolutions.push(hostname); return addresses(hostname); },
    }),
  } };
}

test('native supplemental requests enforce robots on redirects and reject private DNS without contacting it', async () => {
  const faculty = 'https://faculty.clinic.org/people/jane';
  const hidden = 'https://hidden.clinic.org/people/jane';
  const h = nativeWebsiteFixture({
    [`${origin}/robots.txt`]: { text: '' }, [`${origin}/`]: { text: 'No published email' },
    'https://faculty.clinic.org/robots.txt': { text: 'User-agent: *\nDisallow: /private/' },
    [faculty]: { status: 302, location: '/private/contact' },
  }, hostname => [{ address: hostname === 'hidden.clinic.org' ? '10.0.0.2' : '93.184.215.14', family: 4 }]);
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [faculty, hidden] }, h.options);
  assert.deepEqual(results, []);
  assert.deepEqual(h.requests, [`${origin}/robots.txt`, `${origin}/`, 'https://faculty.clinic.org/robots.txt', faculty]);
  assert.match(coverage.pages.find(page => page.url === faculty).error, /robots/);
  assert.equal(coverage.pages.find(page => page.url === hidden).status, 'blocked');
  assert.equal(h.requests.some(url => url.startsWith('https://hidden.clinic.org') || url.includes('/private/')), false);
});

test('native supplemental redirect cannot borrow another explicitly selected origin authorization', async () => {
  const faculty = 'https://faculty.clinic.org/people/jane';
  const journal = 'https://journal.org/paper';
  const h = nativeWebsiteFixture({
    [`${origin}/robots.txt`]: { text: '' }, [`${origin}/`]: { text: 'No published email' },
    'https://faculty.clinic.org/robots.txt': { text: '' },
    [faculty]: { status: 302, location: journal },
    'https://journal.org/robots.txt': { text: '' }, [journal]: { text: 'Jane Doe: jane@clinic.org' },
  });
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [faculty, journal] }, h.options);
  assert.equal(coverage.pages.find(page => page.url === faculty).status, 'blocked');
  assert.match(coverage.pages.find(page => page.url === faculty).error, /left.*blocked/);
  assert.deepEqual(h.requests.slice(0, 4), [`${origin}/robots.txt`, `${origin}/`, 'https://faculty.clinic.org/robots.txt', faculty]);
  assert.deepEqual(h.requests.slice(4), ['https://journal.org/robots.txt', journal]);
  assert.deepEqual(results[0].sources.map(source => source.url), [journal]);
});

test('later named evidence improves display while retaining the earlier unassociated observation and publication age', async () => {
  const faculty = 'https://faculty.clinic.org/people/jane';
  const journal = 'https://journal.org/paper';
  const h = websiteFixture({
    '/': '<p>General public address: jane@clinic.org</p>',
    [faculty]: '<h1>Jane Doe, physician</h1><a href="mailto:jane@clinic.org">Professional email</a>',
    [journal]: '<meta name="citation_publication_date" content="2023/11/16"><p>Correspondence to Jane Doe: jane@clinic.org</p>',
  });
  const { results, coverage } = await discoverWebsite({ sourceUrl: `${origin}/`, supplementalSourceUrls: [faculty, journal], input: { name: 'Jane Doe' } }, h.options);
  assert.equal(results.length, 1);
  const email = results[0];
  assert.equal(email.sources.length, 3);
  assert.equal(email.sources[0].associationEvidence.state, 'not_located');
  assert.equal(email.sources[1].associationEvidence.state, 'name_near_email');
  assert.equal(email.associationEvidence.state, 'name_near_email');
  assert.match(email.context, /Jane Doe/);
  assert.equal(email.flags.includes('person_context_not_located'), false);
  assert.equal(email.sources[2].reportedPublicationDate, '2023-11-16');
  assert.ok(email.sources[2].publicationDateSource);
  assert.equal(coverage.pages.find(page => page.url === journal).reportedPublicationDate, '2023-11-16');
  assert.ok(Date.parse(email.sources[2].observedAt));
  assert.equal(email.ownership, 'unreviewed');
  assert.equal(email.review, 'pending');
  assert.equal(email.deliverability, 'unknown');
  assert.equal(email.verificationAt, null);
});

test('workspace source exclusions block linked and redirected pages before their content request', async () => {
  const h = websiteFixture({ '/': '<h1>Jane Doe</h1><a href="/contact">Contact</a>', '/contact': 'jane@clinic.org' });
  h.options.isSourceExcluded = url => url === `${origin}/contact`;
  const linked = await discoverWebsite({ sourceUrl: `${origin}/`, input: { name: 'Jane Doe' } }, h.options);
  assert.equal(h.attempts.includes(`${origin}/contact`), false);
  assert.equal(linked.results.length, 0);
  assert.equal(linked.coverage.pages.find(page => page.url === `${origin}/contact`).status, 'blocked');
  const requested = [];
  const redirected = await discoverWebsite({ sourceUrl: `${origin}/old-profile` }, {
    now: () => 1000, wait: async () => {}, isSourceExcluded: url => url === `${origin}/contact`,
    fetchPage: async (value, options) => {
      const url = new URL(value);
      if (url.pathname === '/robots.txt') return { url: value, text: '', contentType: 'text/plain' };
      await options.beforeRequest(url); requested.push(url.href);
      await options.beforeRequest(new URL(`${origin}/contact`)); requested.push(`${origin}/contact`);
      return { url: `${origin}/contact`, text: 'jane@clinic.org', contentType: 'text/html' };
    },
  });
  assert.deepEqual(requested, [`${origin}/old-profile`]);
  assert.equal(redirected.results.length, 0);
  assert.equal(redirected.coverage.pages[0].status, 'blocked');
});
