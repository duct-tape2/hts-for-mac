#!/usr/bin/env python3
"""Run the local read-only workspace and reap its process groups on exit.

--reload sends the protocol-specific reload signal only to a validated local
launcher. Terminal SIGHUP stops a v2 launcher; credentials remain backend-only
in memory for the lifetime of that one process.
"""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import warnings

try:  # This launcher is intentionally POSIX-only when using reload control.
    import fcntl
except ImportError:  # pragma: no cover - clear error on non-POSIX hosts
    fcntl = None


ROOT = Path(__file__).resolve().parents[1]
CREDENTIAL_NAMES = ('APP_KEY', 'APP_SECRET', 'APP_KEY_MOCK', 'APP_SECRET_MOCK')
AUTH_OPTIONS = ('KIWOOM_PROFILE', 'KIWOOM_ACCESS_TOKEN', 'KIWOOM_ACCESS_TOKEN_EXPIRES_AT')
CONTROL_VERSION = 2
LEGACY_CONTROL_VERSION = 1


def read_credentials(environment):
    """Read only from the user's terminal; never fall back to echoed stdin."""
    if environment not in ('real', 'demo'):
        raise ValueError('Hidden credential entry requires --environment real or demo.')
    if not sys.stdin.isatty():
        raise ValueError('Run this command in your own Terminal to enter credentials privately.')
    print('키움 %s 조회 연결 · 입력한 키는 표시되지 않습니다.' %
          ('실서버' if environment == 'real' else '모의서버'), flush=True)
    values = []
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        for label in ('App Key', 'App Secret'):
            value = getpass.getpass('%s 붙여넣기 후 Enter: ' % label).strip()
            if not value or any(char.isspace() for char in value):
                raise ValueError('키 값이 비어 있거나 공백/줄바꿈이 포함되어 있습니다. 값을 출력하지 않고 중단합니다.')
            values.append(value)
    names = CREDENTIAL_NAMES[:2] if environment == 'real' else CREDENTIAL_NAMES[2:]
    return dict(zip(names, values))


def child_environments(environment, credentials=None):
    """Return isolated backend/frontend environments without logging values."""
    base = {key: value for key, value in os.environ.items()
            if key not in CREDENTIAL_NAMES + AUTH_OPTIONS}
    base['KIWOOM_ENABLED'] = 'false' if environment == 'fixture' else 'true'
    base['KIWOOM_MODE'] = 'real' if environment == 'fixture' else environment
    base['NEXT_TELEMETRY_DISABLED'] = '1'
    backend_env = dict(base)
    if environment != 'fixture':
        names = CREDENTIAL_NAMES[:2] if environment == 'real' else CREDENTIAL_NAMES[2:]
        supplied = os.environ if credentials is None else credentials
        for name in names:
            if supplied.get(name):
                backend_env[name] = supplied[name]
    return backend_env, base


def _private_runtime_dir(root, override=None):
    """Make one mode-0700, per-user runtime directory for this resolved project."""
    if override is not None:
        directory = Path(override)
    else:
        project_id = hashlib.sha256(str(root.resolve()).encode('utf-8')).hexdigest()[:20]
        directory = Path(tempfile.gettempdir()) / ('kiwoom-local-%s-%s' % (os.geteuid(), project_id))
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.stat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or
            info.st_mode & 0o077):
        raise RuntimeError('Private launcher runtime directory is unavailable.')
    return directory


def _safe_record_read(path):
    """Read a small private regular file, never reflecting its content in errors."""
    try:
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        descriptor = os.open(path, flags)
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                info.st_mode & 0o077 or info.st_size > 4096):
            return None
        with os.fdopen(descriptor, 'r', encoding='utf-8') as handle:
            descriptor = None
            return json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _process_details(pid):
    """Return a process identity without reading its environment."""
    try:
        result = subprocess.run(
            ['ps', '-ww', '-o', 'lstart=', '-o', 'command=', '-p', str(pid)],
            check=False, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, timeout=1,
            # lstart is localized on macOS. Both the launcher and a later
            # control command must compare the same full, fixed-width value.
            env={'PATH': os.defpath, 'LC_ALL': 'C', 'LANG': 'C'},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode or not result.stdout.strip():
        return None
    line = result.stdout.strip()
    # The fixed-width lstart field is 24 characters: "Mon Jan  2 03:04:05 2006".
    if len(line) < 25:
        return None
    return {'start': line[:24], 'command': line[24:].strip()}


class RuntimeControl:
    """Private PID record, exclusive launcher lock, and owned build staging."""

    def __init__(self, root, runtime_dir=None):
        self.root = Path(root).resolve()
        self.directory = _private_runtime_dir(self.root, runtime_dir)
        self.record_path = self.directory / 'launcher.json'
        self.lock_path = self.directory / 'launcher.lock'
        self.stages_dir = self.directory / 'stages'
        self._lock = None
        self._own_start = None

    def acquire(self):
        if fcntl is None:
            raise RuntimeError('Controlled reload requires a POSIX host.')
        self._lock = open(self.lock_path, 'a+', encoding='utf-8')
        os.chmod(self.lock_path, 0o600)
        try:
            fcntl.flock(self._lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._lock.close()
            self._lock = None
            raise RuntimeError('Another local workspace launcher is already running.')

    def release(self):
        if self._lock is not None:
            try:
                fcntl.flock(self._lock.fileno(), fcntl.LOCK_UN)
            finally:
                self._lock.close()
                self._lock = None

    def write_record(self):
        details = _process_details(os.getpid())
        if details is None:
            raise RuntimeError('Cannot establish launcher process identity.')
        self._own_start = details['start']
        record = {
            'version': CONTROL_VERSION,
            'pid': os.getpid(),
            'uid': os.geteuid(),
            'root': str(self.root),
            'launcher': str(Path(__file__).resolve()),
            'start': self._own_start,
        }
        temporary = self.directory / ('.launcher-%s.tmp' % os.getpid())
        payload = json.dumps(record, separators=(',', ':')).encode('utf-8')
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as handle:
                descriptor = None
                handle.write(payload)
            os.replace(temporary, self.record_path)
            os.chmod(self.record_path, 0o600)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass

    def remove_own_record(self):
        record = _safe_record_read(self.record_path)
        if record and record.get('pid') == os.getpid() and record.get('start') == self._own_start:
            try:
                self.record_path.unlink()
            except FileNotFoundError:
                pass

    def create_stage(self):
        self.stages_dir.mkdir(mode=0o700, exist_ok=True)
        info = self.stages_dir.stat()
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise RuntimeError('Private build staging directory is unavailable.')
        return Path(tempfile.mkdtemp(prefix='reload-', dir=self.stages_dir))

    def remove_stage(self, stage):
        if stage is None:
            return
        stage = Path(stage)
        if stage.parent == self.stages_dir and stage.name.startswith('reload-'):
            shutil.rmtree(stage, ignore_errors=True)


def _reload_signal_for_version(version):
    if type(version) is not int:
        return None
    if version == LEGACY_CONTROL_VERSION:
        return getattr(signal, 'SIGHUP', None)
    if version == CONTROL_VERSION:
        return getattr(signal, 'SIGUSR1', None)
    return None


def request_reload(root, runtime_dir=None):
    """Safely signal only the current matching project launcher on POSIX."""
    try:
        control = RuntimeControl(root, runtime_dir)
    except RuntimeError:
        return False
    record = _safe_record_read(control.record_path)
    expected = {
        'uid': os.geteuid(),
        'root': str(Path(root).resolve()),
        'launcher': str(Path(__file__).resolve()),
    }
    if not isinstance(record, dict) or any(record.get(key) != value for key, value in expected.items()):
        return False
    reload_signal = _reload_signal_for_version(record.get('version'))
    if reload_signal is None:
        return False
    pid = record.get('pid')
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    details = _process_details(pid)
    if (details is None or details['start'] != record.get('start') or
            Path(__file__).name not in details['command']):
        return False
    try:
        os.kill(pid, reload_signal)
    except OSError:
        return False
    return True


def _ports_are_available(api_port, web_port):
    for port in (api_port, web_port):
        try:
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind(('127.0.0.1', port))
        except OSError:
            return False, port
    return True, None


def _stop_process_group(process, deadline):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        process.wait(timeout=max(0.01, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            try:
                process.kill()
            except ProcessLookupError:
                return
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            # A last direct-child attempt is preferable to leaking the launcher.
            process.kill()
            process.wait()


def _process_group_exists(group_id):
    """Return whether a launcher-owned group still has any member."""
    try:
        os.killpg(group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # The launcher only creates groups for its own children. Treat an
        # unexpected permission failure as still alive so replacement waits.
        return True
    return True


def stop_children(children):
    """Terminate every owned group, including descendants of an exited leader."""
    groups = tuple(dict.fromkeys(child.pid for child in children))
    for group_id in groups:
        try:
            os.killpg(group_id, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.monotonic() + 5
    for child in children:
        if child.poll() is None:
            try:
                child.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
    surviving_groups = [group_id for group_id in groups if _process_group_exists(group_id)]
    for group_id in surviving_groups:
        try:
            os.killpg(group_id, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    kill_deadline = time.monotonic() + 1
    while surviving_groups and time.monotonic() < kill_deadline:
        # Popen.poll() reaps a direct child after SIGKILL.  Reap before
        # testing its process group: an unreaped zombie remains visible to
        # killpg(..., 0), which would otherwise falsely block replacement.
        for child in children:
            child.poll()
        surviving_groups = [group_id for group_id in surviving_groups
                            if _process_group_exists(group_id)]
        if surviving_groups:
            time.sleep(0.05)
    for child in children:
        if child.poll() is None:
            try:
                child.wait(timeout=max(0.01, kill_deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                # Direct children should be gone after a group SIGKILL; retain
                # the existing final fallback for a platform-level group error.
                try:
                    child.kill()
                except ProcessLookupError:
                    continue
                child.wait()
    # Reap again after any direct-child fallback, then make the return value
    # reflect group liveness after that reap rather than the pre-reap probe.
    for child in children:
        child.poll()
    surviving_groups = [group_id for group_id in groups if _process_group_exists(group_id)]
    return not surviving_groups


def _copy_frontend_for_build(frontend, stage):
    """Copy source/config into a private stage, never modifying live .next."""
    staged_frontend = stage / 'frontend'
    ignored = shutil.ignore_patterns(
        'node_modules', '.next', '.git', '.turbo', '*.log', '.env', '.env.*',
    )
    shutil.copytree(frontend, staged_frontend, ignore=ignored)
    os.symlink(frontend / 'node_modules', staged_frontend / 'node_modules')
    return staged_frontend


def prepare_frontend_build(control, frontend, frontend_env, node, children, stopping):
    """Build a replacement tree while current children continue serving."""
    stage = control.create_stage()
    try:
        staged_frontend = _copy_frontend_for_build(frontend, stage)
        next_cli = staged_frontend / 'node_modules/next/dist/bin/next'
        build = subprocess.Popen(
            [node, str(next_cli), 'build'], cwd=staged_frontend, env=frontend_env,
            start_new_session=True,
        )
        while build.poll() is None:
            if stopping():
                _stop_process_group(build, time.monotonic() + 5)
                control.remove_stage(stage)
                return None, None
            for child in children:
                code = child.poll()
                if code is not None:
                    _stop_process_group(build, time.monotonic() + 5)
                    control.remove_stage(stage)
                    return None, code or 1
            time.sleep(0.05)
        if build.returncode != 0:
            control.remove_stage(stage)
            return None, None
        return stage, None
    except (OSError, shutil.Error):
        control.remove_stage(stage)
        return None, None


def server_commands(root, api_port, web_port, dev, frontend_root=None, node='node'):
    """Construct commands without putting credentials in command arguments."""
    frontend_root = Path(frontend_root) if frontend_root is not None else root / 'frontend'
    python = root / 'backend/.venv/bin/python'
    next_cli = frontend_root / 'node_modules/next/dist/bin/next'
    backend_command = [str(python), '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1',
                       '--port', str(api_port), '--timeout-graceful-shutdown', '2']
    if dev:
        # Uvicorn reloads backend source; Next dev independently provides UI HMR.
        backend_command.extend(['--reload', '--reload-dir', str(root / 'backend/app')])
    frontend_command = [str(node), str(next_cli), 'dev' if dev else 'start', '--hostname',
                        '127.0.0.1', '--port', str(web_port)]
    return (
        (backend_command, root / 'backend'),
        (frontend_command, frontend_root),
    )


def start_children(root, api_port, web_port, dev, backend_env, frontend_env, frontend_root=None, node='node'):
    children = []
    try:
        for command, cwd in server_commands(root, api_port, web_port, dev, frontend_root, node):
            environment = backend_env if cwd == root / 'backend' else frontend_env
            children.append(subprocess.Popen(command, cwd=cwd, env=environment, start_new_session=True))
    except OSError:
        stop_children(children)
        raise
    return children


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dev', action='store_true', help='Use Next development server')
    parser.add_argument('--environment', choices=('fixture', 'real', 'demo'), default='fixture')
    parser.add_argument('--prompt-credentials', action='store_true',
                        help='Enter App Key and App Secret privately in your own terminal; no key file is written')
    parser.add_argument('--reload', action='store_true',
                        help='Safely reload the matching active local launcher without re-entering keys')
    parser.add_argument('--api-port', type=int, default=8010, help=argparse.SUPPRESS)
    parser.add_argument('--web-port', type=int, default=3010, help=argparse.SUPPRESS)
    parser.add_argument('--runtime-dir', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.reload:
        if args.dev or args.prompt_credentials or args.environment != 'fixture':
            parser.error('--reload cannot be combined with launcher options')
        if request_reload(ROOT, args.runtime_dir):
            print('Reload signal sent to the matching local launcher.', flush=True)
            return 0
        print('Reload refused: no matching live local launcher was found.', file=sys.stderr)
        return 1
    if args.prompt_credentials and args.environment == 'fixture':
        parser.error('--prompt-credentials requires --environment real or demo')
    if not (1 <= args.api_port <= 65535 and 1 <= args.web_port <= 65535 and args.api_port != args.web_port):
        parser.error('API and web ports must be distinct values from 1 through 65535')

    root = ROOT.resolve()
    python = root / 'backend/.venv/bin/python'
    next_cli = root / 'frontend/node_modules/next/dist/bin/next'
    node = shutil.which('node')
    if node is None:
        parser.error('Node.js executable is not available in PATH. Install a supported Node.js version and retry.')
    if not python.exists() or not next_cli.exists():
        parser.error('Install dependencies first: ./scripts/setup.sh')
    if not args.dev and not (root / 'frontend/.next/BUILD_ID').exists():
        parser.error('Build frontend first: cd frontend && npm run build')
    available, occupied_port = _ports_are_available(args.api_port, args.web_port)
    if not available:
        parser.error('Port %s is already in use. Stop its owning app before starting.' % occupied_port)

    credentials = None
    if args.prompt_credentials:
        try:
            credentials = read_credentials(args.environment)
        except (EOFError, KeyboardInterrupt):
            print('\n키 입력을 취소했습니다. 서버를 시작하지 않았습니다.', file=sys.stderr)
            return 1
        except (ValueError, getpass.GetPassWarning):
            print('숨김 키 입력 실패: 직접 연 터미널에서 빈칸 없는 키 값을 입력하세요. 서버를 시작하지 않았습니다.', file=sys.stderr)
            return 1
    backend_env, frontend_env = child_environments(args.environment, credentials)
    if credentials is not None:
        credentials.clear()

    try:
        control = RuntimeControl(root, args.runtime_dir)
        control.acquire()
        control.write_record()
    except RuntimeError as error:
        # Deliberately never interpolate credentials or PID-record content.
        print(str(error), file=sys.stderr)
        return 1

    stopping = False
    reload_requested = False
    children = []
    active_stage = None
    result = 0

    def stop(_sig, _frame):
        nonlocal stopping
        stopping = True

    def reload_servers(_sig, _frame):
        nonlocal reload_requested
        reload_requested = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, stop)
    signal.signal(signal.SIGHUP, stop)
    if hasattr(signal, 'SIGUSR1'):
        signal.signal(signal.SIGUSR1, reload_servers)

    try:
        children = start_children(root, args.api_port, args.web_port, args.dev,
                                  backend_env, frontend_env, node=node)
        print('Workspace: http://127.0.0.1:%s | environment: %s | Ctrl+C stops both servers' %
              (args.web_port, args.environment), flush=True)
        while not stopping:
            for child in children:
                code = child.poll()
                if code is not None:
                    result = code or 1
                    stopping = True
                    break
            if stopping:
                break
            if reload_requested:
                reload_requested = False
                next_stage = None
                child_failure = None
                if not args.dev:
                    next_stage, child_failure = prepare_frontend_build(
                        control, root / 'frontend', frontend_env, node, children,
                        lambda: stopping,
                    )
                    if child_failure is not None:
                        result = child_failure
                        stopping = True
                        break
                    if next_stage is None:
                        if not stopping:
                            print('Reload aborted: staged frontend build failed; current servers kept running.',
                                  file=sys.stderr, flush=True)
                        continue
                if stopping:
                    control.remove_stage(next_stage)
                    break
                old_stage = active_stage
                old_children = children
                if not stop_children(old_children):
                    # Do not overlap a replacement with a group the launcher
                    # could not prove dead after bounded SIGKILL handling.
                    control.remove_stage(next_stage)
                    result = 1
                    stopping = True
                    break
                children = []
                control.remove_stage(old_stage)
                active_stage = None
                try:
                    staged_frontend = (next_stage / 'frontend') if next_stage else None
                    children = start_children(root, args.api_port, args.web_port, args.dev,
                                              backend_env, frontend_env, staged_frontend, node)
                    active_stage = next_stage
                    print('Workspace reloaded.', flush=True)
                except OSError:
                    control.remove_stage(next_stage)
                    result = 1
                    stopping = True
                    break
            time.sleep(0.1)
    finally:
        stop_children(children)
        control.remove_stage(active_stage)
        control.remove_own_record()
        control.release()
    return result


if __name__ == '__main__':
    sys.exit(main())
