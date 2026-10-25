"""Credential-entry boundary checks with synthetic strings; no broker traffic."""
import contextlib
import getpass
import importlib.util
import io
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import warnings

path = Path(__file__).resolve().parents[1] / 'scripts/run_local.py'
spec = importlib.util.spec_from_file_location('credential_launcher', path)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class CredentialEntry(unittest.TestCase):
    def test_hidden_entry_returns_pair_without_printing_it(self):
        output = io.StringIO()
        with patch.object(launcher.sys.stdin, 'isatty', return_value=True), \
                patch.object(launcher.getpass, 'getpass', side_effect=['synthetic-key', 'synthetic-secret']), \
                contextlib.redirect_stdout(output):
            credentials = launcher.read_credentials('real')
        self.assertEqual(credentials, {'APP_KEY': 'synthetic-key', 'APP_SECRET': 'synthetic-secret'})
        self.assertNotIn('synthetic-key', output.getvalue())
        self.assertNotIn('synthetic-secret', output.getvalue())

    def test_noninteractive_input_is_rejected_before_read(self):
        with patch.object(launcher.sys.stdin, 'isatty', return_value=False), \
                patch.object(launcher.getpass, 'getpass') as read:
            with self.assertRaises(ValueError):
                launcher.read_credentials('real')
            read.assert_not_called()

    def test_echo_fallback_is_fatal(self):
        def fallback(_prompt):
            warnings.warn('cannot disable echo', getpass.GetPassWarning)
            self.fail('must not reach echoed input')
        with patch.object(launcher.sys.stdin, 'isatty', return_value=True), \
                patch.object(launcher.getpass, 'getpass', side_effect=fallback), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(getpass.GetPassWarning):
                launcher.read_credentials('real')

    def test_invalid_values_are_not_reflected(self):
        for value in ('', 'synthetic\nsecret'):
            with self.subTest(value=bool(value)), \
                    patch.object(launcher.sys.stdin, 'isatty', return_value=True), \
                    patch.object(launcher.getpass, 'getpass', return_value=value), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(ValueError) as error:
                    launcher.read_credentials('demo')
                self.assertNotIn('synthetic', str(error.exception))

    def test_only_selected_credentials_reach_backend(self):
        inherited = {name: 'inherited-sentinel' for name in launcher.CREDENTIAL_NAMES + launcher.AUTH_OPTIONS}
        inherited['PATH'] = '/test/path'
        with patch.dict(os.environ, inherited, clear=True):
            backend, frontend = launcher.child_environments('real', {
                'APP_KEY': 'new-key', 'APP_SECRET': 'new-secret', 'APP_KEY_MOCK': 'not-selected'})
        self.assertEqual(backend['APP_KEY'], 'new-key')
        self.assertEqual(backend['APP_SECRET'], 'new-secret')
        self.assertNotIn('APP_KEY_MOCK', backend)
        for name in launcher.CREDENTIAL_NAMES + launcher.AUTH_OPTIONS:
            self.assertNotIn(name, frontend)
        for name in launcher.AUTH_OPTIONS:
            self.assertNotIn(name, backend)
        self.assertEqual(frontend['PATH'], '/test/path')

    def test_fixture_never_inherits_credentials(self):
        with patch.dict(os.environ, {name: 'sentinel' for name in launcher.CREDENTIAL_NAMES}, clear=True):
            backend, frontend = launcher.child_environments('fixture')
        for env in (backend, frontend):
            self.assertEqual(env['KIWOOM_ENABLED'], 'false')
            self.assertFalse(set(launcher.CREDENTIAL_NAMES).intersection(env))

    def test_demo_keeps_environment_workflow_without_real_keys(self):
        with patch.dict(os.environ, {name: 'sentinel' for name in launcher.CREDENTIAL_NAMES}, clear=True):
            backend, frontend = launcher.child_environments('demo')
        self.assertEqual(backend['APP_KEY_MOCK'], 'sentinel')
        self.assertEqual(backend['APP_SECRET_MOCK'], 'sentinel')
        self.assertNotIn('APP_KEY', backend)
        self.assertNotIn('APP_SECRET', backend)
        self.assertFalse(set(launcher.CREDENTIAL_NAMES).intersection(frontend))


if __name__ == '__main__':
    unittest.main()
