"""Reload-control checks with disposable local processes and synthetic values only."""
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

LAUNCHER = Path(__file__).resolve().parents[1] / 'scripts/run_local.py'
APP_KEY = 'synthetic-app-key'
APP_SECRET = 'synthetic-app-secret'


def open_port(port):
    with socket.socket() as sock:
        sock.settimeout(0.1)
        return sock.connect_ex(('127.0.0.1', port)) == 0


def unused_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def until(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


class ReloadRuntime(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='readonly-reload-')
        self.root = Path(self.tmp.name)
        self.runtime = self.root / 'runtime'
        self.events = self.root / 'events.log'
        self.fail_build = self.root / 'fail-build'
        self.ignore_backend_term = self.root / 'ignore-backend-term'
        self.api_port = unused_port()
        self.web_port = unused_port()
        while self.web_port == self.api_port:
            self.web_port = unused_port()
        self.proc = None
        backend = self.root / 'backend/.venv/bin'
        frontend = self.root / 'frontend'
        next_dir = frontend / 'node_modules/next/dist/bin'
        backend.mkdir(parents=True)
        next_dir.mkdir(parents=True)
        (frontend / '.next').mkdir()
        (frontend / '.next/BUILD_ID').write_text('original-build', encoding='utf-8')
        self._write_backend(backend / 'python')
        self._write_next(next_dir / 'next')

    def tearDown(self):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.communicate()
        self.tmp.cleanup()

    def _write_backend(self, path):
        source = """#!{python}
import os
import signal
import socket
import sys
import time

EVENTS = {events!r}
PORT = {port}
IGNORE_TERM = {ignore_term!r}

def log(line):
    with open(EVENTS, 'a', encoding='utf-8') as handle:
        handle.write(line + '\\n')

key_ok = os.environ.get('APP_KEY') == {app_key!r}
secret_ok = os.environ.get('APP_SECRET') == {app_secret!r}
log('backend-start:%s:%s:%s' % (os.getpid(), int(key_ok), int(secret_ok)))
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', PORT))
listener.listen()

def stop(_signal, _frame):
    if os.path.exists(IGNORE_TERM):
        return
    log('backend-stop:%s' % os.getpid())
    listener.close()
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while True:
    time.sleep(1)
""".format(
            python=sys.executable,
            events=str(self.events),
            port=self.api_port,
            ignore_term=str(self.ignore_backend_term),
            app_key=APP_KEY,
            app_secret=APP_SECRET,
        )
        path.write_text(source, encoding='utf-8')
        path.chmod(0o755)

    def _write_next(self, path):
        source = """const fs = require('fs');
const net = require('net');
const events = %s;
const failBuild = %s;
const port = %s;
function log(line) { fs.appendFileSync(events, line + '\\n'); }
const app = process.env.APP_KEY ? '1' : '0';
const secret = process.env.APP_SECRET ? '1' : '0';
if (process.argv.includes('build')) {
  log('build:' + process.cwd() + ':' + app + ':' + secret);
  if (fs.existsSync(failBuild)) process.exit(9);
  fs.mkdirSync('.next', { recursive: true });
  fs.writeFileSync('.next/BUILD_ID', 'staged-build');
  process.exit(0);
}
log('frontend-start:' + process.pid + ':' + app + ':' + secret);
const server = net.createServer((socket) => socket.end());
server.listen(port, '127.0.0.1');
function stop() {
  log('frontend-stop:' + process.pid);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
""" % (json.dumps(str(self.events)), json.dumps(str(self.fail_build)), self.web_port)
        path.write_text(source, encoding='utf-8')

    def _launcher_command(self, *arguments):
        code = (
            'import importlib.util, pathlib, sys; '
            'spec=importlib.util.spec_from_file_location("launcher",sys.argv[1]); '
            'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); '
            'm.ROOT=pathlib.Path(sys.argv[2]); sys.argv=["launcher"]+sys.argv[3:]; '
            'sys.exit(m.main())'
        )
        return [sys.executable, '-c', code, str(LAUNCHER), str(self.root), *map(str, arguments)]

    def start(self):
        environment = dict(os.environ)
        environment.update({'APP_KEY': APP_KEY, 'APP_SECRET': APP_SECRET})
        self.proc = subprocess.Popen(
            self._launcher_command(
                '--environment', 'real', '--api-port', self.api_port, '--web-port', self.web_port,
                '--runtime-dir', self.runtime,
            ),
            env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.assertTrue(
            until(lambda: open_port(self.api_port) and open_port(self.web_port)),
            'synthetic local servers failed to start',
        )

    def control_reload(self):
        return subprocess.run(
            self._launcher_command('--reload', '--runtime-dir', self.runtime),
            check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10,
        )

    def event_lines(self):
        if not self.events.exists():
            return []
        return self.events.read_text(encoding='utf-8').splitlines()

    def stop_launcher(self, sig=signal.SIGTERM):
        self.proc.send_signal(sig)
        stdout, stderr = self.proc.communicate(timeout=10)
        return self.proc.returncode, stdout + stderr

    def test_reload_retains_backend_only_credentials_and_reaps_old_groups(self):
        self.start()
        initial = self.event_lines()
        first_backend = next(line for line in initial if line.startswith('backend-start:')).split(':')[1]
        first_frontend = next(line for line in initial if line.startswith('frontend-start:')).split(':')[1]
        record = self.runtime / 'launcher.json'
        record_text = record.read_text(encoding='utf-8')
        self.assertNotIn(APP_KEY, record_text)
        self.assertNotIn(APP_SECRET, record_text)
        for pid in (self.proc.pid, first_backend, first_frontend):
            process_command = subprocess.run(
                ['ps', '-o', 'command=', '-p', str(pid)],
                check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            ).stdout
            self.assertNotIn(APP_KEY, process_command)
            self.assertNotIn(APP_SECRET, process_command)

        control = self.control_reload()
        self.assertEqual(control.returncode, 0, control.stderr)
        self.assertNotIn(APP_KEY, control.stdout + control.stderr)
        self.assertNotIn(APP_SECRET, control.stdout + control.stderr)
        self.assertTrue(
            until(lambda: sum(line.startswith('backend-start:') for line in self.event_lines()) == 2 and
                  sum(line.startswith('frontend-start:') for line in self.event_lines()) == 2),
            'replacement servers did not start',
        )
        lines = self.event_lines()
        backend_starts = [line for line in lines if line.startswith('backend-start:')]
        frontend_starts = [line for line in lines if line.startswith('frontend-start:')]
        self.assertTrue(all(line.endswith(':1:1') for line in backend_starts))
        self.assertTrue(all(line.endswith(':0:0') for line in frontend_starts))
        build = next(line for line in lines if line.startswith('build:'))
        self.assertTrue(build.endswith(':0:0'))
        self.assertIn(str(self.runtime / 'stages'), build)
        self.assertEqual((self.root / 'frontend/.next/BUILD_ID').read_text(encoding='utf-8'), 'original-build')

        old_stops = [
            lines.index('backend-stop:' + first_backend),
            lines.index('frontend-stop:' + first_frontend),
        ]
        replacement_starts = [
            lines.index(backend_starts[1]),
            lines.index(frontend_starts[1]),
        ]
        self.assertLess(max(old_stops), min(replacement_starts))
        self.assertTrue(until(lambda: open_port(self.api_port) and open_port(self.web_port)))
        self.assertIsNone(self.proc.poll(), 'controlled reload exited the launcher')

        code, output = self.stop_launcher()
        self.assertEqual(code, 0)
        self.assertNotIn(APP_KEY, output)
        self.assertNotIn(APP_SECRET, output)
        self.assertTrue(until(lambda: not open_port(self.api_port) and not open_port(self.web_port)))
        for path in self.runtime.rglob('*'):
            if path.is_file():
                contents = path.read_text(encoding='utf-8')
                self.assertNotIn(APP_KEY, contents)
                self.assertNotIn(APP_SECRET, contents)

    def test_failed_staged_build_keeps_current_servers_and_live_build_tree(self):
        self.start()
        self.fail_build.write_text('fail', encoding='utf-8')
        control = self.control_reload()
        self.assertEqual(control.returncode, 0, control.stderr)
        self.assertTrue(until(lambda: any(line.startswith('build:') for line in self.event_lines())))
        time.sleep(0.2)
        lines = self.event_lines()
        self.assertEqual(sum(line.startswith('backend-start:') for line in lines), 1)
        self.assertEqual(sum(line.startswith('frontend-start:') for line in lines), 1)
        self.assertTrue(open_port(self.api_port) and open_port(self.web_port))
        self.assertEqual((self.root / 'frontend/.next/BUILD_ID').read_text(encoding='utf-8'), 'original-build')
        self.fail_build.unlink()

    def test_controlled_reload_survives_a_term_ignoring_backend(self):
        self.start()
        self.ignore_backend_term.write_text('ignore', encoding='utf-8')
        control = self.control_reload()
        self.assertEqual(control.returncode, 0, control.stderr)
        self.assertTrue(
            until(lambda: sum(line.startswith('backend-start:') for line in self.event_lines()) == 2 and
                  sum(line.startswith('frontend-start:') for line in self.event_lines()) == 2,
                  seconds=12),
            'controlled reload did not replace the TERM-ignoring backend',
        )
        self.assertIsNone(self.proc.poll(), 'TERM-ignoring backend made the launcher exit')
        self.ignore_backend_term.unlink()
        self.assertTrue(until(lambda: open_port(self.api_port) and open_port(self.web_port)))

    def test_sighup_stops_without_reloading_servers(self):
        self.start()
        code, _output = self.stop_launcher(signal.SIGHUP)
        self.assertEqual(code, 0)
        lines = self.event_lines()
        self.assertEqual(sum(line.startswith('backend-start:') for line in lines), 1)
        self.assertEqual(sum(line.startswith('frontend-start:') for line in lines), 1)
        self.assertFalse(any(line.startswith('build:') for line in lines))
        self.assertTrue(until(lambda: not open_port(self.api_port) and not open_port(self.web_port)))

    def test_stale_control_record_never_signals_an_unrelated_process(self):
        self.runtime.mkdir(mode=0o700)
        sentinel = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            record = {
                'version': 1,
                'pid': sentinel.pid,
                'uid': os.geteuid(),
                'root': str(self.root.resolve()),
                'launcher': str(LAUNCHER.resolve()),
                'start': 'definitely-not-the-sentinel-start-time',
                'ignored': APP_KEY,
            }
            path = self.runtime / 'launcher.json'
            path.write_text(json.dumps(record), encoding='utf-8')
            path.chmod(0o600)
            control = self.control_reload()
            self.assertEqual(control.returncode, 1)
            self.assertIsNone(sentinel.poll(), 'malformed/stale record killed another process')
            self.assertNotIn(APP_KEY, control.stdout + control.stderr)
        finally:
            sentinel.terminate()
            sentinel.wait(timeout=10)

    def test_malformed_control_record_never_signals_an_unrelated_process(self):
        self.runtime.mkdir(mode=0o700)
        sentinel = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            path = self.runtime / 'launcher.json'
            path.write_text('not-json:' + APP_SECRET, encoding='utf-8')
            path.chmod(0o600)
            control = self.control_reload()
            self.assertEqual(control.returncode, 1)
            self.assertIsNone(sentinel.poll(), 'malformed record killed another process')
            self.assertNotIn(APP_SECRET, control.stdout + control.stderr)
        finally:
            sentinel.terminate()
            sentinel.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
