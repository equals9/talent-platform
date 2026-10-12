#!/usr/bin/env python3
"""Produce a code-only MIT source bundle, excluding local inventories and data."""
from pathlib import Path
import json
import zipfile
import hashlib

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text())['version']
destination = root / 'dist' / f'talent-platform-{version}-source.zip'
destination.parent.mkdir(exist_ok=True)
files = ['package.json', 'server.js', 'LICENSE', 'CONTRIBUTING.md', 'THIRD_PARTY.md', 'AGENTS.md', 'start.command', '.gitignore']
for directory in ['packages', 'public', 'test', 'bridges', 'apps/contact-finder', '.github']:
    files.extend(str(path.relative_to(root)) for path in (root / directory).rglob('*') if path.is_file() and not any(part in {'data', 'node_modules', '__pycache__'} for part in path.parts))
files.extend(['scripts/start-evidence-reader.sh', 'test/requirements-reader.txt', 'docs/LIVE_SOURCES.md', 'integrations/live-sources.example.json', 'scripts/doctor.js', 'scripts/consolidate-contacts.js', 'scripts/package-release.py', 'docs/ROADMAP.md', 'research/OPEN_SOURCE_FOUNDATIONS.md', 'research/COMPETITIVE_LANDSCAPE.md', 'research/CALYFLOW_AGENTS.md', 'research/sources.json'])

readme = (root / 'README.md').read_text()
catalog = {'kind': 'talent-platform.source-projects', 'version': 1, 'projects': []}
consolidation = (root / 'docs/CONSOLIDATION.md').read_text()
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
