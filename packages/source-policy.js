import { link } from './workspace.js';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
export function exclusionUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(link(value));
    url.protocol = 'https:'; url.hostname = url.hostname.replace(/^www\./, '');
    url.hash = ''; url.search = ''; url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href;
  } catch { return ''; }
}
export function setupSourcePolicy(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_profile_exclusions(value TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_source_exclusions(id TEXT PRIMARY KEY, document TEXT NOT NULL);`);
}
export function syncSourceExclusions(db, feed) {
  if (!Array.isArray(feed.suppressions)) throw fail('The configured source exclusion feed is unavailable. Retry after restoring the reader.', 503);
  const validated = feed.suppressions.map(item => {
    const value = item.kind === 'profile_url' ? exclusionUrl(item.value) : item.kind === 'email' && typeof item.value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.value) ? item.value.toLowerCase() : '';
    if (!value) throw fail('A source exclusion cannot be interpreted safely; review its original record.', 503);
    return { ...item, value };
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of validated) {
      const id = `${item.sourceProject || 'talentos'}:${item.sourceRecordId}:${item.kind}:${item.value}`;
      db.prepare('INSERT OR IGNORE INTO platform_source_exclusions(id,document) VALUES(?,?)').run(id, JSON.stringify(item));
      if (item.kind === 'email') db.prepare('INSERT OR IGNORE INTO suppressed(email,created_at) VALUES(?,?)').run(item.value, item.createdAt || new Date().toISOString());
      else db.prepare('INSERT OR IGNORE INTO platform_profile_exclusions(value,document) VALUES(?,?)').run(item.value, JSON.stringify(item));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function isProfileExcluded(db, subject) {
  if (!subject) return false;
  const urls = [...(subject.profileUrls || []), subject.profileUrl, subject.linkedinUrl].filter(Boolean);
  return urls.some(url => {
    const key = exclusionUrl(url);
    return key && db.prepare('SELECT value FROM platform_profile_exclusions WHERE value=?').get(key);
  });
}
export function requireIncluded(db, subject) {
  if (isProfileExcluded(db, subject)) throw fail('This public profile is excluded across the connected workspace.');
}
