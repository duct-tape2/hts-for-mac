#!/usr/bin/env python3
"""Create a curated source snapshot; never copy runtime data or Git history."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil

ROOT = Path(__file__).resolve().parents[1]
EXPLICIT = (
    'README.md', 'NOTICE.md', 'VERSION', 'dev.sh', '.gitignore',
    'backend/README.md', 'backend/pyproject.toml', 'backend/uv.lock',
    'frontend/README.md', 'frontend/package.json', 'frontend/package-lock.json',
    'frontend/next-env.d.ts', 'frontend/next.config.ts', 'frontend/tsconfig.json',
    'frontend/vitest.config.mts', 'frontend/tailwind.config.ts', 'frontend/postcss.config.mjs',
    'frontend/public/popout.html', '.github/workflows/ci.yml',
    'docs/hts/MAC-MOVE.md', 'docs/hts/OPEN-SOURCE.md', 'docs/hts/RELEASE-VERIFICATION.md',
)
TREES = ('backend/app', 'backend/tests', 'frontend/src', 'scripts', 'tests')
SUFFIXES = {'.py', '.sh', '.ts', '.tsx', '.css', '.json', '.mjs', '.mts'}
FORBIDDEN = {'.git', '.venv', 'node_modules', '__pycache__', '.next', 'data', 'memory'}


def selected_files(root: Path) -> list[Path]:
    files = [root / name for name in EXPLICIT]
    for name in TREES:
        for path in (root / name).rglob('*'):
            relative = path.relative_to(root)
            if any(part in FORBIDDEN or part.startswith('.env') for part in relative.parts):
                continue
            if path.is_file() and path.suffix in SUFFIXES:
                files.append(path)
    for path in files:
        if not path.is_file() or path.is_symlink():
            raise ValueError(f'Release requires regular file: {path.relative_to(root)}')
        if root.resolve() not in path.resolve().parents:
            raise ValueError('Release file resolves outside source tree')
    return sorted(set(files))


def build_snapshot(root: Path, destination: Path) -> dict[str, str]:
    if destination.exists():
        raise ValueError('Destination must not exist; release snapshots are immutable')
    files = selected_files(root)
    destination.mkdir(parents=True)
    manifest = {}
    for path in files:
        relative = path.relative_to(root)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        manifest[str(relative)] = hashlib.sha256(target.read_bytes()).hexdigest()
    (destination / 'SOURCE-MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    manifest = build_snapshot(ROOT, args.destination)
    print(f'Curated {len(manifest)} files into {args.destination}')
