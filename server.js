import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp as createContactApp } from './apps/contact-finder/server.js';
import { setupWorkspace, workspaceRoutes } from './packages/workspace.js';
import { planImport, importPreview, commitImport } from './packages/imports.js';
import { probeIntegrationStatus } from './scripts/doctor.js';
import { createLiveSources, readLiveConfig } from './packages/live-sources.js';
import { setupEvidence, liveWorkspaceRoutes } from './packages/source-workspace.js';
import { setupSourcePolicy, syncSourceExclusions, isProfileExcluded } from './packages/source-policy.js';

const root = dirname(fileURLToPath(import.meta.url));

export function createPlatform({ dataDir = join(root, 'data'), discovery, liveConfig = dataDir === join(root, 'data') ? readLiveConfig(root) : {}, sources = createLiveSources(liveConfig) } = {}) {
  const researchExcluded = (db, job) => isProfileExcluded(db, { ...job.input, profileUrls: [...(job.profileUrls || []), job.sourceUrl, ...(job.supplementalSourceUrls || []), ...(job.coverage?.pages || []).map(page => page.url), ...(job.results || []).flatMap(result => (result.sources || []).map(source => source.url))].filter(Boolean) });
  return createContactApp({ dataDir, discovery, isJobExcluded: researchExcluded, isInputExcluded: researchExcluded, configure: db => { setupWorkspace(db); setupSourcePolicy(db); setupEvidence(db); }, extraRoutes: async (request, response, url, context) => {
    if (url.pathname.startsWith('/api/') && !['/api/sources/status', '/api/projects', '/api/integrations/status'].includes(url.pathname)) {
      // Sticky exclusions are copied only into this platform. A failed configured
      // feed blocks actions instead of claiming the source has no exclusions.
      try { syncSourceExclusions(context.db, await sources.exclusions()); }
      catch { throw Object.assign(new Error('The source exclusion feed is unavailable. Restore its reader before continuing this action.'), { status: 503 }); }
    }
    if (request.method === 'GET') {
      const assets = {
        '/': ['public/index.html', 'text/html; charset=utf-8'],
        '/platform.js': ['public/platform.js', 'text/javascript; charset=utf-8'],
        '/platform.css': ['public/platform.css', 'text/css; charset=utf-8'],
        '/contacts': ['apps/contact-finder/public/index.html', 'text/html; charset=utf-8'],
        '/contacts/': ['apps/contact-finder/public/index.html', 'text/html; charset=utf-8'],
        '/contacts/app.js': ['apps/contact-finder/public/app.js', 'text/javascript; charset=utf-8'],
        '/contacts/style.css': ['apps/contact-finder/public/style.css', 'text/css; charset=utf-8'],
      };
      const asset = assets[url.pathname];
      if (asset) {
        let content = readFileSync(join(root, asset[0]), 'utf8');
        if (url.pathname.startsWith('/contacts')) content = content.replace('href="/style.css"', 'href="/contacts/style.css"').replace('src="/app.js"', 'src="/contacts/app.js"');
        context.send(response, 200, content, asset[1]); return true;
      }
      if (url.pathname === '/api/projects') {
        const localCatalog = join(root, 'integrations/source-projects.local.json');
        const catalog = existsSync(localCatalog) ? localCatalog : join(root, 'integrations/source-projects.json');
        context.send(response, 200, JSON.parse(readFileSync(catalog, 'utf8'))); return true;
      }
      if (url.pathname === '/api/integrations/status') { context.send(response, 200, { integrations: await probeIntegrationStatus() }); return true; }
    }
    if (await liveWorkspaceRoutes(request, response, url, context, sources)) return true;
    if (url.pathname === '/api/import' && request.method === 'POST') {
      const input = await context.bodyJson(request);
      const plan = planImport(input.format, input.content);
      if (input.commit !== true) context.send(response, 200, { preview: importPreview(plan) });
      else context.send(response, 201, { import: commitImport(context.db, plan) });
      return true;
    }
    return workspaceRoutes(request, response, url, context);
  } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.TALENT_PLATFORM_PORT || 4320);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('TALENT_PLATFORM_PORT must be an integer between 1024 and 65535.');
  if (!existsSync(join(root, 'public/index.html'))) throw new Error('The platform interface is missing. Restore the source files before starting.');
  const app = createPlatform();
  app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Open the existing workspace.` : 'The platform could not start.'); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1', () => console.log(`Talent Platform v0.3.0: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
