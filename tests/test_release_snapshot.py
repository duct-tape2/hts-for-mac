from pathlib import Path
import importlib.util
import json
import pytest

spec = importlib.util.spec_from_file_location('release_snapshot', Path(__file__).resolve().parents[1] / 'scripts/build_release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def tree(tmp_path, monkeypatch):
    root = tmp_path / 'source'
    (root / 'backend/app').mkdir(parents=True)
    (root / 'backend/app/main.py').write_text('print("fixture")')
    monkeypatch.setattr(release, 'EXPLICIT', ())
    return root


def test_only_curated_code_is_copied_and_hashes_are_recorded(tmp_path, monkeypatch):
    root = tree(tmp_path, monkeypatch)
    (root / 'backend/app/.env').write_text('synthetic-secret')
    (root / 'backend/app/data').mkdir()
    (root / 'backend/app/data/credentials.json').write_text('synthetic-secret')
    (root / 'backend/app/__pycache__').mkdir()
    (root / 'backend/app/__pycache__/discard.py').write_text('discard')
    target = tmp_path / 'snapshot'
    manifest = release.build_snapshot(root, target)
    assert set(manifest) == {'backend/app/main.py'}
    assert json.loads((target / 'SOURCE-MANIFEST.json').read_text()) == manifest
    assert not (target / 'backend/app/.env').exists()
    assert not (target / 'backend/app/data').exists()


def test_symlink_and_existing_destination_are_rejected(tmp_path, monkeypatch):
    root = tree(tmp_path, monkeypatch)
    outside = tmp_path / 'outside.py'
    outside.write_text('private')
    (root / 'backend/app/leak.py').symlink_to(outside)
    with pytest.raises(ValueError, match='regular file'):
        release.build_snapshot(root, tmp_path / 'rejected')
    assert not (tmp_path / 'rejected').exists()
    with pytest.raises(ValueError, match='must not exist'):
        release.build_snapshot(root, root)
