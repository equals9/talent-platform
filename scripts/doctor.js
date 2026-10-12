import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const manifestUrl = new URL('../integrations/source-projects.json', import.meta.url);

// This list is code-owned. No caller, manifest, environment variable or URL
// parameter can change the destinations of a status check.
const localServices = Object.freeze([
  Object.freeze({ id: 'lead-finder', label: 'Original Lead Finder', endpoint: 'http://127.0.0.1:4318/', identityKnown: true }),
  Object.freeze({ id: 'candidate-os-api', label: 'Candidate Intelligence OS API', endpoint: 'http://127.0.0.1:8716/health', identityKnown: true }),
  Object.freeze({ id: 'candidate-os-ui', label: 'Candidate Intelligence OS workspace', endpoint: 'http://127.0.0.1:3217/', identityKnown: true }),
  Object.freeze({ id: 'talentos', label: 'TalentOS declared default port', endpoint: 'http://127.0.0.1:3000/', identityKnown: false }),
]);

/** Reachability only. A response does not establish application identity or integration. */
export async function probeIntegrationStatus({ fetchImpl = globalThis.fetch } = {}) {
  return Promise.all(localServices.map(async ({ id, label, endpoint, identityKnown }) => {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { Accept: 'application/json, text/html;q=0.5' },
        signal: AbortSignal.timeout(500),
      });
      // Never read a candidate payload, issue a follow-up request, or retain a
      // response body. In particular, redirect responses are not followed.
      if (response.body?.cancel) await response.body.cancel();
      if (response.status >= 300 && response.status < 400) {
        return { id, label, status: 'redirect_not_followed', endpoint, message: `HTTP ${response.status}; redirect was not followed. Integration is unverified.` };
      }
      if (!response.ok) {
        return { id, label, status: 'unavailable', endpoint, message: `HTTP ${response.status}; the endpoint did not return a successful response.` };
      }
      return {
        id, label, status: 'reachable_unknown', endpoint,
        message: identityKnown
          ? `HTTP ${response.status}; endpoint reachable. Application identity, records and adapter operation were not checked.`
          : `HTTP ${response.status}; this shared development port responded. The service has not been identified as TalentOS.`,
      };
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return { id, label, status: 'offline', endpoint, message: timedOut ? 'No response within 500 ms. No service was started.' : 'Connection unavailable. No service was started.' };
    }
  }));
}

export function validateCatalog(manifest) {
  if (manifest?.kind !== 'talent-platform.source-projects' || manifest.version !== 1 || !Array.isArray(manifest.projects)) {
    throw new Error('Invalid source project catalog: expected talent-platform.source-projects version 1.');
  }
  const identifiers = new Set();
  for (const project of manifest.projects) {
    if (!project || typeof project.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(project.id) || identifiers.has(project.id)) {
      throw new Error('Invalid source project catalog: each project requires a unique ID.');
    }
    identifiers.add(project.id);
    if (typeof project.label !== 'string' || !project.label.trim() || typeof project.path !== 'string' || !path.isAbsolute(project.path)) {
      throw new Error(`Invalid source project catalog: ${project.id} needs a label and absolute local path.`);
    }
    if (typeof project.role !== 'string' || typeof project.integrationStatus !== 'string') {
      throw new Error(`Invalid source project catalog: ${project.id} needs role and integrationStatus.`);
    }
  }
  for (const project of manifest.projects) {
    if (project.aliasOf && (!identifiers.has(project.aliasOf) || project.aliasOf === project.id)) {
      throw new Error(`Invalid source project catalog: ${project.id} refers to an unknown alias owner.`);
    }
  }
  return manifest;
}

async function gitValue(directory, args) {
  const { stdout } = await executeFile('git', ['--no-optional-locks', '-C', directory, ...args], {
    timeout: 1500,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function sourceStatus(project) {
  const result = { id: project.id, label: project.label, path: project.path, relationship: project.relationship, aliasOf: project.aliasOf, integrationStatus: project.integrationStatus };
  try {
    const information = await stat(project.path);
    if (!information.isDirectory()) return { ...result, sourceStatus: 'not_directory' };
  } catch {
    return { ...result, sourceStatus: 'missing' };
  }
  try {
    const [head, branch, status] = await Promise.all([
      gitValue(project.path, ['rev-parse', 'HEAD']),
      gitValue(project.path, ['branch', '--show-current']),
      gitValue(project.path, ['status', '--porcelain=v1', '--untracked-files=normal']),
    ]);
    const changed = status ? status.split('\n') : [];
    // Paths are counted, not returned. The doctor never opens the files.
    const untracked = changed.filter(line => line.startsWith('??')).length;
    return { ...result, sourceStatus: 'present', gitStatus: 'observed', head, branch, changedPaths: { total: changed.length, tracked: changed.length - untracked, untracked }, differsFromCatalogHead: Boolean(project.head && head !== project.head) };
  } catch {
    return { ...result, sourceStatus: 'present', gitStatus: project.head ? 'unavailable' : 'not_required_or_unavailable', message: 'Git metadata could not be read within the bounded check; no source was modified.' };
  }
}

export async function inspectSourceProjects() {
  const manifest = validateCatalog(JSON.parse(await readFile(manifestUrl, 'utf8')));
  return Promise.all(manifest.projects.map(sourceStatus));
}

async function main() {
  try {
    const [sources, integrations] = await Promise.all([inspectSourceProjects(), probeIntegrationStatus()]);
    process.stdout.write(`${JSON.stringify({ catalogValid: true, observedAt: new Date().toISOString(), mode: 'read-only', sourceCount: sources.length, sources, integrations }, null, 2)}\n`);
    // Missing/offline source services are honest states, not a corrupt catalog.
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ catalogValid: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
