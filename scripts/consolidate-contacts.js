import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../apps/contact-finder/server.js';
import { setupWorkspace } from '../packages/workspace.js';
import { importLegacyContacts } from '../packages/imports.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceFile = process.argv[2];
if (!sourceFile) throw new Error('Pass the existing Lead Finder contacts.sqlite path. The source is read-only.');
const dataDir = join(root, 'data');
const app = createApp({ dataDir, configure: setupWorkspace });
await app.close();
const db = new DatabaseSync(join(dataDir, 'contacts.sqlite'));
try { console.log(JSON.stringify(importLegacyContacts(db, resolve(sourceFile)), null, 2)); }
finally { db.close(); }
