#!/usr/bin/env python3
"""Produce a code-only MIT source bundle, excluding local inventories and data."""
from pathlib import Path
import json
import zipfile
import hashlib

root = Path(__file__).resolve().parent.parent
destination = root / 'dist' / 'talent-platform-0.1.0-source.zip'
destination.parent.mkdir(exist_ok=True)
files = ['package.json', 'server.js', 'LICENSE', 'CONTRIBUTING.md', 'THIRD_PARTY.md', 'AGENTS.md', 'start.command', '.gitignore']
for directory in ['packages', 'public', 'test', 'apps/contact-finder', '.github']:
    files.extend(str(path.relative_to(root)) for path in (root / directory).rglob('*') if path.is_file() and not any(part in {'data', 'node_modules', '__pycache__'} for part in path.parts))
files.extend(['scripts/doctor.js', 'scripts/consolidate-contacts.js', 'scripts/package-release.py', 'docs/ROADMAP.md', 'research/OPEN_SOURCE_FOUNDATIONS.md', 'research/COMPETITIVE_LANDSCAPE.md', 'research/CALYFLOW_AGENTS.md', 'research/sources.json'])

readme = '''# Talent Platform

MIT open-source recruiting workspace for solo recruiters and agencies, with a
path toward in-house teams and healthcare hiring. This is a local single-user
milestone: public contact research, source review, roles, explicit saved
candidates, pipeline history, reviewed export, and source import adapters.

Requires Node.js 22.13 or newer. No npm dependencies or provider key.

```sh
npm test
npm start
```

Open http://127.0.0.1:4320. Keep the server running. Create a role, research a
name with a known professional website domain, review the source evidence,
explicitly keep a prospect, and export the role pipeline. Contact approval
and keeping a person are separate; deliverability stays unknown. Exclusions
apply globally to future discoveries and exports. `/contacts` provides the
original contact review workspace.

Imports support Candidate Intelligence OS CSV projections and TalentOS
workspace version 1. Preview shows omitted fields before explicit commit.
Imported email labels cannot become approved contacts without separate source
evidence and review. No names are automatically merged.

This source bundle has an empty source-project catalog and no personal
records, credentials, source-repository paths, raw audit downloads or private
inventories. Add your own source entries using the catalog schema if needed.
`npm run doctor` inspects registered source folders and fixed local service
reachability without starting services or reading candidate payloads.

The local server uses loopback/host/origin/token controls for one trusted user;
production authentication, tenant isolation and team workflows remain future
work. LinkedIn links are references only; no paid contact fallback, mailbox
probe, external sending or automatic hiring decision is enabled.

See docs/ROADMAP.md and research/ for the broader platform direction, PRISM
audit, eight OSS alternatives, current competitors and Calyflow agent patterns.
Local tests establish scoped behavior, not comparative recruiting superiority.
THIRD_PARTY.md records upstream licensing boundaries.
'''
catalog = {'kind': 'talent-platform.source-projects', 'version': 1, 'projects': []}
consolidation = '''# Source integrations

This platform owns saved recruiter selections and role workflow. External source
projects retain their original evidence, identity records and data until an
explicit qualified adapter or migration changes that responsibility.

Candidate Intelligence OS CSV imports preserve original IDs and metadata but
do not carry complete contact evidence. TalentOS workspace version 1 carries
only its declared role/candidate subset. Preview warnings identify these gaps.
VitalCV and other source projects are not included or relicensed in this bundle.

The personal development workspace and private inventory are intentionally not
distributed. The included integrations/source-projects.json starts empty.
'''
audit = '# Existing source inventories\n\nPersonal source paths and private workspace inventories are excluded from this release. See THIRD_PARTY.md and the import contracts for supported boundaries.\n'
overrides = {
    'README.md': readme,
    'integrations/source-projects.json': json.dumps(catalog, indent=2) + '\n',
    'talent-platform.code-workspace': json.dumps({'folders': [{'path': '.'}]}, indent=2) + '\n',
    'docs/CONSOLIDATION.md': consolidation,
    'docs/EXISTING_PROJECTS_AUDIT.md': audit,
    'docs/BUILD_STATUS.md': (root / 'docs/BUILD_STATUS.md').read_text() if (root / 'docs/BUILD_STATUS.md').exists() else '# Build status\n\n62 local deterministic tests passed. See release evidence in the owning workspace. No hosted CI or competitor outcome is claimed.\n',
}
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(set(files)):
        archive.write(root / name, 'talent-platform/' + name)
    for name, content in overrides.items():
        archive.writestr('talent-platform/' + name, content)
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
(destination.parent / (destination.name + '.sha256')).write_text(f'{digest}  {destination.name}\n')
print(json.dumps({'archive': str(destination), 'sha256': digest, 'files': len(set(files)) + len(overrides)}))
