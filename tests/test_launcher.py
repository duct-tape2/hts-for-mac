"""Process-lifecycle tests using disposable local servers, no app/broker imports."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import call, patch

LAUNCHER = Path(__file__).resolve().parents[1] / 'scripts/run_local.py'
SPEC = importlib.util.spec_from_file_location('lifecycle_launcher', LAUNCHER)
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


def open_port(port):
    with socket.socket() as sock:
        sock.settimeout(0.1)
        return sock.connect_ex(('127.0.0.1', port)) == 0


def unused_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def until(predicate, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class LauncherLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='readonly-launcher-')
        self.root = Path(self.tmp.name)
        self.proc = None
        self.api_port = unused_port()
        self.web_port = unused_port()
        while self.web_port == self.api_port:
            self.web_port = unused_port()
        backend = self.root / 'backend/.venv/bin'
        frontend = self.root / 'frontend/node_modules/next/dist/bin'
        backend.mkdir(parents=True)
        frontend.mkdir(parents=True)
        self.api = backend / 'python'
        self.api.write_text('#!' + sys.executable + '\nimport http.server\nhttp.server.HTTPServer(("127.0.0.1",%s),http.server.BaseHTTPRequestHandler).serve_forever()\n' % self.api_port)
        self.api.chmod(0o755)
        (frontend / 'next').write_text('require("http").createServer((q,s)=>s.end("fixture")).listen(%s,"127.0.0.1");\n' % self.web_port)

    def tearDown(self):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        if self.proc:
            for stream in (self.proc.stdout, self.proc.stderr):
                if stream:
                    stream.close()
        self.tmp.cleanup()

    def start(self):
        code = ('import importlib.util, pathlib, sys; '
                'spec=importlib.util.spec_from_file_location("launcher",sys.argv[1]); '
                'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); '
                'm.ROOT=pathlib.Path(sys.argv[2]); sys.argv=["launcher","--dev","--api-port",sys.argv[3],"--web-port",sys.argv[4],"--runtime-dir",sys.argv[5]]; '
                'sys.exit(m.main())')
        self.proc = subprocess.Popen([sys.executable, '-c', code, str(LAUNCHER), str(self.root),
                                      str(self.api_port), str(self.web_port), str(self.root / 'runtime')],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def assert_signal_reaps_both_servers(self, interrupt):
        self.start()
        self.assertTrue(until(lambda: open_port(self.api_port) and open_port(self.web_port)), 'servers failed to start')
        self.proc.send_signal(interrupt)
        code = self.proc.wait(timeout=8)
        self.assertEqual(code, 0, self.proc.stderr.read())
        self.assertTrue(until(lambda: not open_port(self.api_port) and not open_port(self.web_port)), 'server survived launcher exit')

    def test_sigint_reaps_both_servers(self):
        self.assert_signal_reaps_both_servers(signal.SIGINT)

    def test_sigterm_reaps_both_servers(self):
        self.assert_signal_reaps_both_servers(signal.SIGTERM)

    def test_backend_failure_stops_frontend(self):
        self.api.write_text('#!' + sys.executable + '\nimport time,sys\ntime.sleep(.8)\nsys.exit(7)\n')
        self.start()
        self.assertEqual(self.proc.wait(timeout=8), 7)
        self.assertTrue(until(lambda: not open_port(self.web_port)), 'frontend survived backend failure')

    def test_exited_backend_leader_grandchild_is_reaped_on_failure(self):
        grandchild = (
            'import http.server; '
            'http.server.HTTPServer(("127.0.0.1",%s),http.server.BaseHTTPRequestHandler).serve_forever()'
            % self.api_port
        )
        self.api.write_text(
            '#!' + sys.executable +
            '\nimport subprocess,sys,time\n'
            'subprocess.Popen([sys.executable,"-c",%r])\n'
            'time.sleep(1)\n'
            'sys.exit(9)\n' % grandchild,
        )
        self.start()
        self.assertTrue(
            until(lambda: open_port(self.api_port) and open_port(self.web_port)),
            'leader did not leave the synthetic HTTP grandchild running',
        )
        self.assertEqual(self.proc.wait(timeout=10), 9)
        self.assertTrue(
            until(lambda: not open_port(self.api_port) and not open_port(self.web_port)),
            'orphaned process group member survived launcher failure cleanup',
        )


class LauncherCommands(unittest.TestCase):
    def test_process_identity_is_independent_of_terminal_locale(self):
        with patch.dict(os.environ, {'LC_ALL': 'ko_KR.UTF-8', 'LANG': 'ko_KR.UTF-8'}):
            details = launcher._process_details(os.getpid())
        self.assertIsNotNone(details)
        self.assertEqual(len(details['start']), 24)
        self.assertRegex(details['start'], r'^[A-Z][a-z]{2} [A-Z][a-z]{2} ')
        with patch.object(launcher.subprocess, 'run') as run:
            run.return_value = subprocess.CompletedProcess([], 0, 'Sat Oct 24 17:51:03 2026 python run_local.py\n')
            launcher._process_details(123)
            self.assertEqual(run.call_args.args[0], ['ps', '-ww', '-o', 'lstart=', '-o', 'command=', '-p', '123'])
            self.assertEqual(run.call_args.kwargs['env'], {'PATH': os.defpath, 'LC_ALL': 'C', 'LANG': 'C'})

    def test_missing_node_is_a_clean_preflight_error(self):
        output = io.StringIO()
        with patch.object(launcher.shutil, 'which', return_value=None), \
                patch.object(launcher.sys, 'argv', ['launcher']), \
                contextlib.redirect_stderr(output), \
                self.assertRaises(SystemExit) as exited:
            launcher.main()
        self.assertEqual(exited.exception.code, 2)
        self.assertIn('Node.js executable is not available in PATH', output.getvalue())

    def test_backend_has_bounded_graceful_shutdown_in_all_modes(self):
        root = Path('/tmp/launcher-command-test')
        for dev in (False, True):
            (backend, _backend_cwd), _frontend = launcher.server_commands(root, 18100, 13100, dev)
            self.assertIn('--timeout-graceful-shutdown', backend)
            self.assertEqual(backend[backend.index('--timeout-graceful-shutdown') + 1], '2')
            if dev:
                self.assertIn('--reload', backend)
                self.assertEqual(backend[backend.index('--reload-dir') + 1], str(root / 'backend/app'))


class ReloadControlProtocol(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='readonly-reload-protocol-')
        self.root = Path(self.tmp.name)
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir(mode=0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def write_record(self, version):
        record = {
            'version': version,
            'pid': 4242,
            'uid': os.geteuid(),
            'root': str(self.root.resolve()),
            'launcher': str(LAUNCHER.resolve()),
            'start': 'Sat Oct 24 17:51:03 2026',
        }
        path = self.runtime / 'launcher.json'
        path.write_text(json.dumps(record), encoding='utf-8')
        path.chmod(0o600)
        return record

    def test_reload_dispatches_legacy_and_current_protocol_signals(self):
        for version, expected_signal in ((launcher.LEGACY_CONTROL_VERSION, signal.SIGHUP), (launcher.CONTROL_VERSION, signal.SIGUSR1)):
            with self.subTest(version=version):
                record = self.write_record(version)
                details = {'start': record['start'], 'command': 'python scripts/run_local.py'}
                with patch.object(launcher, '_process_details', return_value=details), \
                        patch.object(launcher.os, 'kill') as kill:
                    self.assertTrue(launcher.request_reload(self.root, self.runtime))
                self.assertEqual(kill.call_args_list, [call(record['pid'], 0), call(record['pid'], expected_signal)])

    def test_reload_rejects_unknown_or_non_integer_record_versions_before_signaling(self):
        for version in (0, 3, True, '2'):
            with self.subTest(version=version):
                self.write_record(version)
                with patch.object(launcher.os, 'kill') as kill:
                    self.assertFalse(launcher.request_reload(self.root, self.runtime))
                kill.assert_not_called()


class ProcessGroupCleanup(unittest.TestCase):
    def test_term_ignoring_child_is_reaped_before_cleanup_reports_success(self):
        port = unused_port()
        source = (
            'import http.server, signal; '
            'signal.signal(signal.SIGTERM, lambda *_: None); '
            'http.server.HTTPServer(("127.0.0.1",%s),http.server.BaseHTTPRequestHandler).serve_forever()'
            % port
        )
        child = subprocess.Popen(
            [sys.executable, '-c', source],
            start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            self.assertTrue(until(lambda: open_port(port)), 'TERM-ignoring server did not start')
            self.assertTrue(launcher.stop_children([child]))
            self.assertIsNotNone(child.poll(), 'TERM-ignoring direct child was not reaped')
            self.assertTrue(until(lambda: not open_port(port)), 'TERM-ignoring child kept its port')
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


if __name__ == '__main__':
    unittest.main()
