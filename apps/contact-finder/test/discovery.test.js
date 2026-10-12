import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { discover, extractEmails, isPlausibleEmail, isPublicIp, safeFetch, sanitizeSourceUrl, validatePublicUrl } from '../discovery.js';

test('SSRF guard denies local, mapped, metadata, documentation, and reserved IPs', () => {
  for (const ip of ['127.0.0.1', '10.8.1.2', '172.16.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.1.2.3', '198.18.0.1', '192.0.2.5', '203.0.113.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2002:7f00:1::', '2001:db8::1', '3fff::1']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  for (const ip of ['93.184.215.14', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicIp(ip), true, ip);
});

test('URL guard handles numeric-IP disguises, credentials, schemes, ports, and LinkedIn', () => {
  for (const url of ['http://2130706433', 'http://0x7f000001', 'http://127.1', 'http://[::ffff:7f00:1]', 'http://localhost.', 'http://router.local/', 'file:///etc/passwd', 'ftp://public.org', 'https://u:p@public.org', 'https://public.org:3000', 'https://www.linkedin.com/in/person', 'https://linkedin.com./in/person', 'https://lnkd.in/path']) {
    assert.throws(() => validatePublicUrl(url), undefined, url);
  }
  assert.equal(validatePublicUrl('https://www.public.org/contact#email').href, 'https://www.public.org/contact');
  assert.equal(sanitizeSourceUrl('https://public.org/contact?api_key=SECRET&topic=care#contact'), 'https://public.org/contact?topic=care');
});

test('extracts source emails, mailto and encoded emails without scripts, templates or assets', () => {
  const source = `<style>.x { background: url(hidden@fake.org) }</style>
    <script>const email = 'tracking@fake.org'</script><!-- comment@fake.org -->
    <template>template@fake.org</template><noscript>hidden@fake.org</noscript>
    <h1>Dr. Alice Smith</h1><p>Email Alice@clinic.org for public enquiries.</p>
    <a href="mailto:alice%40clinic.org?subject=test">Email Alice</a>
    <a href='mailto:bob&#64;clinic.org?cc=private@fake.org'>Bob</a>
    <p>info&commat;clinic&period;org</p><p>carol%40clinic.org</p>
    <img src="logo@2x.png"> <p>name@example.com</p>`;
  const rows = extractEmails(source, { html: true });
  assert.deepEqual(rows.map(r => r.email), ['alice@clinic.org', 'info@clinic.org', 'carol@clinic.org', 'bob@clinic.org']);
  assert.match(rows[0].context, /Dr\. Alice Smith/);
  assert.deepEqual(rows.find(r => r.email.startsWith('info')).flags, ['shared_mailbox']);
  assert.equal(rows.some(r => r.email.endsWith('@fake.org')), false);
});

test('plain text preserves angle-bracket addresses and rejects malformed and asset-like tokens', () => {
  assert.deepEqual(extractEmails('Alice <alice@clinic.org>; Jane jane.doe+jobs@clinic.org. logo@2x.png').map(r => r.email), ['alice@clinic.org', 'jane.doe+jobs@clinic.org']);
  for (const email of ['a..b@clinic.org', '.a@clinic.org', 'x@-clinic.org', 'x@clinic-.org', 'name@example.com', 'logo@2x.png', 'x@clinic']) assert.equal(isPlausibleEmail(email), false, email);
  assert.equal(isPlausibleEmail("o'connor+work@clinic.org"), true);
  assert.equal(extractEmails('bad@clinic.org_unsafe').length, 0);
  assert.equal(extractEmails('a..b@clinic.org .a@clinic.org a@clinic.org.123 a@@clinic.org https://login@clinic.org/').length, 0);
  assert.equal(extractEmails(Array.from({ length: 75 }, (_, n) => `person${n}@clinic.org`).join(' ')).length, 50);
});

test('discovery never assigns ownership or deliverability from a pasted mention', async () => {
  const results = await discover({ mode: 'paste', input: { name: 'Some Other Person' }, sourceText: 'Alice: alice@clinic.org\nOffice: info@clinic.org', sourceUrl: 'https://clinic.org/team' });
  assert.equal(results.length, 2);
  for (const row of results) {
    assert.equal(row.ownership, 'unreviewed');
    assert.equal(row.deliverability, 'unknown');
    assert.equal(row.review, 'pending');
    assert.equal(row.verificationAt, null);
    assert.equal(row.sourceType, 'pasted_text');
    assert.equal(row.sources[0].url, 'https://clinic.org/team');
    assert.ok(Date.parse(row.sources[0].observedAt));
    assert.ok(row.flags.includes('user_supplied_source_text'));
    assert.equal('person' in row, false);
  }
  const unsourced = await discover({ mode: 'paste', sourceText: 'alice@clinic.org' });
  assert.deepEqual(unsourced[0].sources, []);
  assert.ok(unsourced[0].flags.includes('missing_source_url'));
  const angleAddress = await discover({ mode: 'paste', sourceText: 'Pat <p@clinic.org>' });
  assert.equal(angleAddress[0].email, 'p@clinic.org');
  assert.deepEqual(await discover({ mode: 'paste', sourceText: 'No public address listed.' }), []);
  await assert.rejects(discover({ mode: 'hunter' }), /disabled/);
  await assert.rejects(discover({ mode: 'paste', sourceText: ' ' }), /Paste/);
  await assert.rejects(discover({ mode: 'paste', sourceText: 'x'.repeat(2 * 1024 * 1024 + 1) }), /2 MB/);
});

function fakeRequest(responses, calls = []) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => queueMicrotask(() => {
      calls.push({ url: url.href, options });
      const response = new EventEmitter();
      response.destroy = () => {};
      const data = responses.shift();
      response.statusCode = data.status ?? 200;
      response.headers = data.headers ?? { 'content-type': 'text/html' };
      callback(response);
      if (!data.status || data.status === 200) {
        for (const chunk of data.chunks ?? [data.text ?? '<p>public@clinic.org</p>']) response.emit('data', Buffer.from(chunk));
        response.emit('end');
      }
    });
    return request;
  };
}

test('fetch rejects mixed public/private DNS before a connection is attempted', async () => {
  let requested = false;
  await assert.rejects(safeFetch('https://public.org', {
    lookupImpl: async () => [{ address: '93.184.215.14', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }],
    requestImpl: () => { requested = true; },
  }), /private/);
  assert.equal(requested, false);
});

test('fetch pins the public DNS answer, strips fragments, and follows a public relative redirect', async () => {
  const calls = [];
  const page = await safeFetch('https://public.org/old#anchor', {
    lookupImpl: async () => [{ address: '93.184.215.14', family: 4 }],
    requestImpl: fakeRequest([{ status: 302, headers: { location: '/contact' } }, { text: 'alice@clinic.org', headers: { 'content-type': 'text/plain; charset=utf-8' } }], calls),
  });
  assert.equal(page.url, 'https://public.org/contact');
  assert.equal(page.text, 'alice@clinic.org');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://public.org/old');
  for (const call of calls) {
    assert.equal(call.options.agent, false);
    assert.equal(call.options.headers.Cookie, undefined);
    assert.equal(call.options.headers.Authorization, undefined);
    call.options.lookup('public.org', { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '93.184.215.14', family: 4 }]);
    });
  }
});

test('every redirect is revalidated; private destinations and LinkedIn are never contacted', async () => {
  for (const destination of ['http://169.254.169.254/latest/meta-data/', 'https://www.linkedin.com/in/person']) {
    const calls = [];
    await assert.rejects(safeFetch('https://public.org', {
      lookupImpl: async () => [{ address: '93.184.215.14', family: 4 }],
      requestImpl: fakeRequest([{ status: 302, headers: { location: destination } }], calls),
    }));
    assert.equal(calls.length, 1);
  }
  let resolutions = 0;
  const calls = [];
  await assert.rejects(safeFetch('https://public.org', {
    lookupImpl: async () => ++resolutions === 1 ? [{ address: '93.184.215.14', family: 4 }] : [{ address: '10.0.0.1', family: 4 }],
    requestImpl: fakeRequest([{ status: 302, headers: { location: 'https://other.org/' } }], calls),
  }), /private/);
  assert.equal(calls.length, 1);
});

test('fetch rejects oversized streams, compressed downloads, nontext and sign-in failures', async () => {
  const cases = [
    [{ headers: { 'content-type': 'text/html', 'content-length': '2097153' } }, /2 MB/],
    [{ chunks: ['x'.repeat(1024 * 1024), 'x'.repeat(1024 * 1024 + 1)] }, /2 MB/],
    [{ headers: { 'content-type': 'application/pdf' } }, /HTML or plain-text/],
    [{ headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } }, /compressed/],
    [{ status: 403, headers: {} }, /HTTP 403/],
  ];
  for (const [response, message] of cases) {
    await assert.rejects(safeFetch('https://public.org', {
      lookupImpl: async () => [{ address: '93.184.215.14', family: 4 }], requestImpl: fakeRequest([response]),
    }), message);
  }
});

test('fetch caps redirect chains at three', async () => {
  const calls = [];
  await assert.rejects(safeFetch('https://public.org', {
    lookupImpl: async () => [{ address: '93.184.215.14', family: 4 }],
    requestImpl: fakeRequest(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/again' } })), calls),
  }), /more than three/);
  assert.equal(calls.length, 4);
});
