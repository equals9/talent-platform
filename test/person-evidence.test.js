import test from 'node:test';
import assert from 'node:assert/strict';
import { discover, extractEmails, isPlausibleEmail, publicPageMetadata } from '../apps/contact-finder/discovery.js';

const PERSON = 'Alice Smith';
const EMAIL = 'alice@clinic.org';
const SOURCE = 'https://clinic.org/faculty/alice';

test('a named mailto-only contact retains visible context as a review hint', async () => {
  const content = `<h2>Dr. Alice Smith</h2><p>Clinical Faculty</p><a href="mailto:alice%40clinic.org?subject=Hello">Email</a>`;
  const [row] = extractEmails(content, { html: true, name: PERSON });
  assert.equal(row.email, EMAIL);
  assert.equal(row.quoteKind, 'html_email_link');
  assert.equal(row.associationEvidence.state, 'name_near_email');
  assert.match(row.associationEvidence.quote, /Dr\. Alice Smith/);
  assert.equal(row.associationEvidence.authority, 'textual_context_requires_human_review');
  assert.match(row.context, /Email link on source page: alice@clinic\.org/);

  const [observation] = await discover({ mode: 'paste', input: { name: PERSON }, sourceUrl: SOURCE, sourceText: content });
  assert.equal(observation.review, 'pending');
  assert.equal(observation.ownership, 'unreviewed');
  assert.equal(observation.deliverability, 'unknown');
  assert.equal(observation.verificationAt, null);
  assert.equal(observation.sources[0].associationEvidence.state, 'name_near_email');
  assert.equal(observation.sources[0].url, SOURCE);
  assert.match(observation.sources[0].contentHash, /^[a-f0-9]{64}$/);
});

test('a name after the previous person’s visible address cannot support that address', () => {
  const rows = extractEmails('<p>Bob Jones: bob@clinic.org</p><p>Alice Smith: alice@clinic.org</p>', { html: true, name: PERSON });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].email, 'bob@clinic.org');
  assert.equal(rows[0].associationEvidence.state, 'not_located');
  assert.ok(rows[0].flags.includes('person_context_not_located'));
  assert.equal(rows[1].associationEvidence.state, 'name_near_email');
  assert.doesNotMatch(rows[1].associationEvidence.quote, /Bob Jones/);
});

test('the current mailto anchor’s visible name can support its own address without proving ownership', async () => {
  const content = `<p>Clinical Faculty</p><a href="mailto:alice@clinic.org"><strong>Alice Smith</strong></a>`;
  const [row] = extractEmails(content, { html: true, name: PERSON });
  assert.equal(row.email, EMAIL);
  assert.equal(row.associationEvidence.state, 'name_near_email');
  assert.match(row.associationEvidence.quote, /Alice Smith/);
  assert.equal(row.associationEvidence.authority, 'textual_context_requires_human_review');
  assert.equal(row.quoteKind, 'html_email_link');
  const [observation] = await discover({ mode: 'paste', input: { name: PERSON }, sourceUrl: SOURCE, sourceText: content });
  assert.equal(observation.ownership, 'unreviewed');
  assert.equal(observation.review, 'pending');
  assert.equal(observation.deliverability, 'unknown');
  assert.equal(observation.verificationAt, null);
});

test('a preceding visible email resets the person-context boundary', () => {
  const rows = extractEmails('Alice Smith: alice@clinic.org. Another contact: bob@clinic.org.', { name: PERSON });
  assert.equal(rows[0].associationEvidence.state, 'name_near_email');
  assert.equal(rows[1].email, 'bob@clinic.org');
  assert.equal(rows[1].associationEvidence.state, 'not_located');
  assert.equal(rows[1].associationEvidence.quote, undefined);
});

test('a preceding mailto-only email also resets the person-context boundary', () => {
  const content = `<section><h2>Alice Smith</h2><a href="mailto:alice@clinic.org">Email Alice</a></section>
    <section><h2>Bob Jones</h2><a href="mailto:bob@clinic.org">Email Bob</a></section>`;
  const rows = extractEmails(content, { html: true, name: PERSON });
  assert.deepEqual(rows.map(row => row.email), [EMAIL, 'bob@clinic.org']);
  assert.equal(rows[0].associationEvidence.state, 'name_near_email');
  assert.equal(rows[1].associationEvidence.state, 'not_located');
  assert.ok(rows[1].flags.includes('person_context_not_located'));
});

test('a supplied name and domain do not generate emails from scripts or private markup', () => {
  const hiddenOnly = `<h2>Alice Smith</h2><p>Website: clinic.org. No published email.</p>
    <script>const pattern = 'alice@clinic.org';</script>
    <style>.contact { background: url(style@clinic.org); }</style>
    <template>template@clinic.org</template><noscript>fallback@clinic.org</noscript>
    <!-- private@clinic.org -->
    <div data-address="attribute@clinic.org">Contact form</div>`;
  assert.deepEqual(extractEmails(hiddenOnly, { html: true, name: PERSON }), []);
  assert.deepEqual(extractEmails('Alice Smith, clinic.org; first.last at employer domain', { name: PERSON }), []);
});

test('the observed form-placeholder address is rejected without rejecting all example local parts', () => {
  for (const placeholder of ['example@email.com', 'EXAMPLE@EMAIL.COM']) assert.equal(isPlausibleEmail(placeholder), false);
  assert.equal(isPlausibleEmail('example@clinic.org'), true);
  assert.deepEqual(extractEmails('example@email.com, example@clinic.org, alice@clinic.org').map(row => row.email), ['example@clinic.org', EMAIL]);
});

test('malformed publication dates do not discard otherwise observed emails', async () => {
  for (const date of ['2023-99-99', '2023-02-29', '2023-00-12', 'not a date']) {
    const content = `<div><meta name="citation_title" content="A published study"><meta name="citation_publication_date" content="${date}">
      <h2>Alice Smith</h2><p>Correspondence: alice@clinic.org</p></div>`;
    assert.deepEqual(publicPageMetadata(content), { sourcePurpose: 'publication_correspondence' });
    const rows = await discover({ mode: 'paste', input: { name: PERSON }, sourceUrl: SOURCE, sourceText: content });
    assert.equal(rows.length, 1, date);
    assert.equal(rows[0].email, EMAIL);
    assert.equal(rows[0].sources[0].reportedPublicationDate, undefined);
    assert.equal(rows[0].sources[0].sourcePurpose, 'publication_correspondence');
    assert.equal(rows[0].deliverability, 'unknown');
  }
});

test('publication date remains separate from current retrieval and contact review', async () => {
  const content = `<div><meta name="citation_title" content="A published study"><meta name="citation_date" content="2001/2/3">
    <h2>Alice Smith</h2><p>Correspondence: alice@clinic.org</p></div>`;
  const before = Date.now();
  const [row] = await discover({ mode: 'paste', input: { name: PERSON }, sourceUrl: SOURCE, sourceText: content });
  const after = Date.now();
  const source = row.sources[0];
  assert.equal(source.reportedPublicationDate, '2001-02-03');
  assert.equal(source.publicationDateSource, 'citation_date');
  assert.equal(source.sourcePurpose, 'publication_correspondence');
  assert.ok(Date.parse(source.observedAt) >= before && Date.parse(source.observedAt) <= after);
  assert.equal(row.date, source.observedAt);
  assert.notEqual(source.observedAt.slice(0, 10), source.reportedPublicationDate);
  assert.equal(row.review, 'pending');
  assert.equal(row.deliverability, 'unknown');
  assert.equal(row.verificationAt, null);
});

test('hidden metadata cannot supply a publication date or correspondence purpose', () => {
  assert.deepEqual(publicPageMetadata(`<script><meta name="citation_date" content="2001-02-03"></script>
    <template><meta name="citation_title" content="Hidden title"></template>
    <!-- <meta property="article:published_time" content="2001-02-03"> -->`), {});
  assert.deepEqual(publicPageMetadata('<meta name="citation_date" content="2001-02-03">', { html: false }), {});
});
