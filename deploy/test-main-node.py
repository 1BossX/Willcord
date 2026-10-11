#!/usr/bin/env python3
"""Drive `willcord main …` with a fake docker and a local HTTPS /health.

Needs the debug build (cargo build --manifest-path worker/Cargo.toml): its test
seams (WILLCORD_TEST_ADDRS, WILLCORD_TEST_OS) do not exist in release builds.
"""
import http.server
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest

from wizard_pty import BINARY, SERVER, SERVER_CHOICE, answers, drive, install_fake_docker

TLS_CONFIG = '''[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=127.0.0.1
[v3]
basicConstraints=critical,CA:FALSE
subjectAltName=IP:127.0.0.1
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
'''


class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = (self.server.root / 'health.json').read_bytes() if self.path == '/health' else b'{}'
        self.send_response(200 if self.path == '/health' else 404)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a): pass


class MainNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert BINARY.exists(), f'build the debug binary first: {BINARY}'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wc-main-test-')
        self.root = Path(self.temp.name)
        (self.root / 'tls').mkdir()
        install_fake_docker(self.root / 'bin')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(self.root / 'tls/key.pem'), '-out', str(self.root / 'tls/cert.pem'), '-days', '1', '-config', self.write(TLS_CONFIG)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.set_health(True)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.root / 'tls/cert.pem', self.root / 'tls/key.pem')
        self.server = http.server.HTTPServer(('127.0.0.1', 0), Health)
        self.server.root = self.root
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f'https://127.0.0.1:{self.server.server_port}'
        self.deploy = self.root / 'deployment'
        self.env = {**os.environ, 'LANG': 'en_US.UTF-8', 'PATH': f'{self.root / "bin"}:{os.environ["PATH"]}',
                    'TEST_ROOT': str(self.root), 'WILLCORD_TEST_ADDRS': '', 'WILLCORD_TEST_OS': 'Linux',
                    # init puts the command on PATH and remembers the deployment: keep both in a scratch home.
                    'HOME': str(self.root / 'home')}
        for name in ['SSL_CERT_FILE', 'WILLCORD_CONFIG_DIR', 'WILLCORD_HOME']:
            self.env.pop(name, None)
        (self.root / 'home').mkdir()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def write(self, text):
        path = self.root / 'tls/openssl.cnf'
        path.write_text(text)
        return str(path)

    def set_health(self, ready):
        (self.root / 'health.json').write_text(json.dumps({'alive': True, 'scheduling_ready': ready}))

    def calls(self):
        path = self.root / 'calls'
        return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []

    def compose_calls(self):
        return [a[1:] for a, _ in self.calls() if a[:1] == ['compose']]

    def cli(self, *args, env=None, cwd=None):
        return subprocess.run([str(BINARY), *args], env={**self.env, **(env or {})}, capture_output=True, text=True, cwd=cwd, timeout=60)

    answers = staticmethod(answers)

    def init(self, extra=(), env=None, answers=None, server=True, version=True):
        argv = [str(BINARY), 'main', 'init', '--dir', str(self.deploy)]
        if server:
            argv += ['--server', self.origin]
        if version:
            argv += ['--image-version', 'v1.2.3']
        argv += list(extra)
        try:
            return drive(argv, {**self.env, **(env or {})}, answers or self.answers())
        except TimeoutError as e:
            self.fail(str(e))

    # ------------------------------------------------------------------ init

    def test_init_generates_private_config_and_removes_password(self):
        code, out = self.init()
        self.assertEqual(code, 0, out)
        main_env = (self.deploy / 'main.env').read_text()
        dot_env = (self.deploy / '.env').read_text()
        for name in ['main.env', '.env', 'compose.yaml']:
            self.assertEqual((self.deploy / name).stat().st_mode & 0o777, 0o600, name)
        self.assertEqual((self.deploy / 'ca.pem').stat().st_mode & 0o777, 0o644)
        self.assertNotIn('INITIAL_ADMIN_PASSWORD', main_env)
        self.assertNotIn('MODEL_', main_env, 'the model is bound later, in the console')
        self.assertIn(f'PUBLIC_BASE_URL="{self.origin}"', main_env)
        self.assertIn(f'WILLCORD_PORT="{self.server.server_port}"', dot_env)
        self.assertIn(f'WILLCORD_SITE="127.0.0.1:{self.server.server_port}"', dot_env)
        self.assertIn('WILLCORD_VERSION="1.2.3"', dot_env)
        self.assertIn('COMPOSE_PROJECT_NAME="willcord-', dot_env)
        self.assertIn('WILLCORD_VERSION:?set WILLCORD_VERSION', (self.deploy / 'compose.yaml').read_text())
        self.assertNotIn('long\'password', out)
        # The first password goes and main restarts without it.
        self.assertEqual(self.compose_calls(), [['version'], ['pull'], ['up', '-d'], ['cp', 'caddy:/data/caddy/pki/authorities/local/root.crt', './ca.pem'], ['up', '-d', 'main']])
        self.assertTrue((self.deploy / 'willcord').exists(), 'a copy of the binary stays beside the deployment')
        self.assertIn('willcord main status', out)
        self.assertNotIn('./willcord', out)
        self.assertIn('“模型连接”绑定模型 API key', out)
        # Existing config is never replaced.
        before = (self.deploy / 'main.env').read_bytes()
        code, out = self.init()
        self.assertNotEqual(code, 0, out)
        self.assertIn('拒绝覆盖', out)
        self.assertEqual((self.deploy / 'main.env').read_bytes(), before)

    def test_init_on_macos_docker_desktop(self):
        code, out = self.init(env={'WILLCORD_TEST_OS': 'Darwin'})
        self.assertEqual(code, 0, out)
        self.assertIn('Docker Desktop', out)

    def test_init_needs_an_image_version_in_a_dev_build(self):
        code, out = self.init(version=False)
        self.assertNotEqual(code, 0, out)
        self.assertIn('--image-version', out)
        self.assertFalse(self.deploy.exists() and any(self.deploy.iterdir()))
        for bad in ['v1.2', 'latest']:
            code, out = self.init(extra=['--image-version', bad], version=False)
            self.assertNotEqual(code, 0, out)

    def test_init_refuses_a_bad_origin_and_missing_docker(self):
        for server in ['http://plane.internal', 'https://plane.internal/x', 'https://plane.internal:0']:
            code, out = self.init(server=False, extra=['--server', server])
            self.assertNotEqual(code, 0, server)
            self.assertFalse(self.deploy.exists() and (self.deploy / 'main.env').exists())
        for env, needle in [({'TEST_NO_COMPOSE': '1'}, 'Docker Compose v2'), ({'TEST_DOCKER_DOWN': '1'}, '无法访问 Docker')]:
            code, out = self.init(env=env)
            self.assertNotEqual(code, 0, out)
            self.assertIn(needle, out)
        code, out = self.init(env={'PATH': '/nonexistent'})
        self.assertNotEqual(code, 0)
        self.assertIn('缺少 docker', out)
        self.assertFalse((self.deploy / 'main.env').exists())

    def test_init_asks_no_model_questions(self):
        code, out = self.init()
        self.assertEqual(code, 0, out)
        for gone in ['模型 provider', '模型名称', '模型 API key:']:
            self.assertNotIn(gone, out)

    # Detected addresses are offered by number; the health check still targets the
    # local test server, so a numbered pick stops at the failing pull after the
    # configuration is written.
    ADDRS = {'WILLCORD_TEST_ADDRS': 'lo=127.0.0.1,docker0=172.17.0.1,utun3=10.8.0.2,en0=192.168.1.5'}

    def test_detected_addresses_are_offered_best_first_and_a_number_picks_one(self):
        env = {**self.ADDRS, 'TEST_START_FAIL': '1'}
        code, out = self.init(server=False, env=env, answers=[(SERVER_CHOICE, b'2\n'), *self.answers()])
        self.assertNotEqual(code, 0, out)
        # Same private range: the real card (en0) comes before the tunnel (utun3).
        self.assertIn('1) https://192.168.1.5:8443   en0', out)
        self.assertIn('2) https://10.8.0.2:8443   utun3', out)
        self.assertNotIn('127.0.0.1:8443', out)
        self.assertNotIn('172.17.0.1', out)
        self.assertIn('DHCP', out)
        self.assertIn('WILLCORD_SITE="10.8.0.2:8443"', (self.deploy / '.env').read_text())
        self.assertIn('PUBLIC_BASE_URL="https://10.8.0.2:8443"', (self.deploy / 'main.env').read_text())

    def test_enter_takes_the_first_detected_address(self):
        env = {**self.ADDRS, 'TEST_START_FAIL': '1'}
        code, out = self.init(server=False, env=env, answers=[(SERVER_CHOICE, b'\n'), *self.answers()])
        self.assertNotEqual(code, 0, out)
        self.assertIn('WILLCORD_SITE="192.168.1.5:8443"', (self.deploy / '.env').read_text())

    def test_a_typed_origin_overrides_the_detected_addresses(self):
        code, out = self.init(server=False, env=self.ADDRS, answers=[(SERVER_CHOICE, self.origin.encode() + b'\n'), *self.answers()])
        self.assertEqual(code, 0, out)
        self.assertIn(f'PUBLIC_BASE_URL="{self.origin}"', (self.deploy / 'main.env').read_text())

    def test_a_number_outside_the_list_is_refused_before_anything_is_written(self):
        code, out = self.init(server=False, env=self.ADDRS, answers=[(SERVER_CHOICE, b'9\n')])
        self.assertNotEqual(code, 0, out)
        self.assertIn('没有序号 9', out)
        self.assertEqual(list(self.deploy.iterdir()), [])

    def test_without_a_detected_address_the_placeholder_is_the_default(self):
        code, out = self.init(server=False, answers=[(SERVER, b'\n'), *self.answers()], env={'TEST_START_FAIL': '1'})
        self.assertNotEqual(code, 0, out)
        self.assertIn('[https://plane.internal:8443]', out)
        self.assertIn('WILLCORD_SITE="plane.internal:8443"', (self.deploy / '.env').read_text())

    def test_the_password_needs_sixteen_characters(self):
        answers = self.answers()[:-1] + [('管理员密码'.encode(), b'short\n')]
        code, out = self.init(answers=answers)
        self.assertNotEqual(code, 0, out)
        self.assertIn('至少需要 16 字符', out)
        self.assertEqual(list(self.deploy.iterdir()), [])
        # Sixteen characters, not bytes.
        shutil.rmtree(self.deploy)
        code, out = self.init(answers=self.answers()[:-1] + [('管理员密码'.encode(), '密码密码密码密码密码密码密码密码\n'.encode())])
        self.assertEqual(code, 0, out)

    def test_init_finishes_with_a_command_to_trust_the_root_certificate(self):
        for env, needle in [({'WILLCORD_TEST_OS': 'Darwin'}, 'security add-trusted-cert'), ({}, 'update-ca-certificates')]:
            with self.subTest(env=env):
                shutil.rmtree(self.deploy, ignore_errors=True)
                code, out = self.init(env=env)
                self.assertEqual(code, 0, out)
                self.assertIn(needle, out)
                self.assertIn('deployment/ca.pem', out)

    def test_start_failure_keeps_config_and_password_for_recovery(self):
        code, out = self.init(env={'TEST_START_FAIL': '1'})
        self.assertNotEqual(code, 0, out)
        self.assertIn('docker compose logs', out)
        self.assertIn('INITIAL_ADMIN_PASSWORD=', (self.deploy / 'main.env').read_text())

    # ------------------------------------------------------ day-to-day

    def deployed(self):
        code, out = self.init()
        self.assertEqual(code, 0, out)
        (self.root / 'calls').unlink()

    def test_up_down_logs_run_compose_in_the_deployment(self):
        self.deployed()
        for command, expected in [(['up'], ['up', '-d']), (['down'], ['down']), (['logs', 'main', '--tail', '50'], ['logs', 'main', '--tail', '50'])]:
            r = self.cli('main', *command, '--dir', str(self.deploy))
            self.assertEqual(r.returncode, 0, r.stderr)
            args, cwd = self.calls()[-1]
            self.assertEqual(args, ['compose', *expected])
            self.assertEqual(Path(cwd).resolve(), self.deploy.resolve())

    def test_commands_find_the_deployment_beside_the_binary_or_in_the_current_directory(self):
        self.deployed()
        r = self.cli('main', 'up', cwd=self.deploy)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = subprocess.run([str(self.deploy / 'willcord'), 'main', 'up'], env=self.env, capture_output=True, text=True, cwd=self.root)
        self.assertEqual(r.returncode, 0, r.stderr)
        # --dir wins over everything and must hold a deployment.
        r = self.cli('main', 'up', '--dir', str(self.root))
        self.assertNotEqual(r.returncode, 0)

    def test_commands_work_from_any_directory_after_init(self):
        self.deployed()
        remembered = self.root / 'home/.config/willcord/main-dir'
        self.assertEqual(remembered.read_text(), str(self.deploy.resolve()))
        self.assertEqual(remembered.stat().st_mode & 0o777, 0o600)
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir()
        r = self.cli('main', 'status', cwd=elsewhere)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(Path(self.calls()[-1][1]).resolve(), self.deploy.resolve())
        # Another deployment in the current directory is nearer than the remembered one.
        other = self.root / 'other'
        other.mkdir()
        (other / 'compose.yaml').write_text('')
        self.cli('main', 'up', cwd=other)
        self.assertEqual(Path(self.calls()[-1][1]).resolve(), other.resolve())
        # With no memory, say what to do.
        r = self.cli('main', 'up', cwd=elsewhere, env={'HOME': str(self.root / 'nobody')})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('--dir', r.stderr)
        # A deployment that was moved away is named, not silently replaced.
        shutil.rmtree(self.deploy)
        r = self.cli('main', 'up', cwd=elsewhere)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(str(self.deploy.resolve()), r.stderr)

    # ------------------------------------------------ the command on PATH

    def installed(self):
        return self.root / 'home/.local/bin/willcord'

    def test_init_puts_willcord_on_path_and_says_how_to_reach_it(self):
        code, out = self.init()
        self.assertEqual(code, 0, out)
        self.assertTrue(self.installed().is_file())
        self.assertEqual(self.installed().stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.installed().read_bytes(), BINARY.read_bytes())
        # ~/.local/bin is not on this PATH: one export line, and no shell file is touched.
        self.assertIn('export PATH="$HOME/.local/bin:$PATH"', out)
        self.assertEqual(sorted(p.name for p in (self.root / 'home').iterdir()), ['.config', '.local'])
        # The copy works: it is the program.
        r = subprocess.run([str(self.installed()), 'version'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_no_path_hint_when_the_directory_is_already_on_path(self):
        on_path = f'{self.root / "home/.local/bin"}:{self.env["PATH"]}'
        code, out = self.init(env={'PATH': on_path})
        self.assertEqual(code, 0, out)
        self.assertIn('已安装命令', out)
        self.assertNotIn('export PATH', out)

    def test_a_file_that_is_not_ours_is_left_alone_and_hints_use_the_real_path(self):
        self.installed().parent.mkdir(parents=True)
        self.installed().write_text('#!/bin/sh\necho not willcord\n')
        code, out = self.init()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.installed().read_text(), '#!/bin/sh\necho not willcord\n')
        self.assertIn('没有覆盖', out)
        self.assertNotIn('export PATH', out)
        self.assertIn(f"'{self.deploy.resolve()}/willcord' main status", out)

    def test_self_install_and_self_uninstall(self):
        r = self.cli('self-install')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(self.installed().is_file())
        # Again: the same copy is already there.
        r = self.cli('self-install')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('命令已就位', r.stdout)
        # An older copy of ours is replaced.
        self.installed().write_bytes(b'willcord-cli-install-marker-v1\0\0 old')
        r = self.cli('self-install')
        self.assertIn('已更新命令', r.stdout)
        self.assertEqual(self.installed().read_bytes(), BINARY.read_bytes())
        # The installed copy is a full willcord, and removes itself on request.
        r = subprocess.run([str(self.installed()), 'self-uninstall'], env=self.env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(self.installed().exists())
        r = self.cli('self-uninstall')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('不存在', r.stdout)
        # A foreign file is neither replaced nor removed, and self-install says so with a failure.
        self.installed().write_text('mine')
        r = self.cli('self-install')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('没有覆盖', r.stderr)
        r = self.cli('self-uninstall')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.installed().read_text(), 'mine')
        # System scope writes /usr/local/bin and needs root.
        r = self.cli('self-install', '--system')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('root', r.stderr)

    def test_status_reports_health_using_the_deployments_own_ca(self):
        self.deployed()
        r = self.cli('main', 'status', '--dir', str(self.deploy))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('主节点已就绪', r.stdout)
        self.assertEqual(self.compose_calls()[-1], ['ps'])
        self.set_health(False)
        r = self.cli('main', 'status', '--dir', str(self.deploy))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('scheduling_ready', r.stderr)
        # A certificate the CA did not issue is not trusted, not even one the
        # machine itself trusts (SSL_CERT_FILE stands in for the system store).
        self.set_health(True)
        other = self.root / 'tls/other.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(self.root / 'tls/other-key.pem'), '-out', str(other), '-days', '1', '-config', self.write(TLS_CONFIG)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.copyfile(other, self.deploy / 'ca.pem')
        r = self.cli('main', 'status', '--dir', str(self.deploy))
        self.assertNotEqual(r.returncode, 0)
        system_trusts_it = {'SSL_CERT_FILE': str(self.root / 'tls/cert.pem')}
        r = self.cli('main', 'status', '--dir', str(self.deploy), env=system_trusts_it)
        self.assertNotEqual(r.returncode, 0, 'a system-trusted certificate must not stand in for the deployment CA')
        # With its own CA back, the same environment is fine.
        shutil.copyfile(self.root / 'tls/cert.pem', self.deploy / 'ca.pem')
        r = self.cli('main', 'status', '--dir', str(self.deploy), env=system_trusts_it)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_upgrade_changes_only_the_image_version(self):
        self.deployed()
        before = (self.deploy / '.env').read_text()
        r = self.cli('main', 'upgrade', '--image-version', 'v1.3.0', '--dir', str(self.deploy))
        self.assertEqual(r.returncode, 0, r.stderr)
        after = (self.deploy / '.env').read_text()
        self.assertEqual(after, before.replace('WILLCORD_VERSION="1.2.3"', 'WILLCORD_VERSION="1.3.0"'))
        self.assertEqual(self.compose_calls(), [['pull'], ['up', '-d']])
        for bad in [[], ['--image-version', 'nightly']]:
            r = self.cli('main', 'upgrade', *bad, '--dir', str(self.deploy))
            self.assertNotEqual(r.returncode, 0)
        self.assertEqual((self.deploy / '.env').read_text(), after)

    # ------------------------------------------------- worker data directory

    def test_worker_refuses_a_data_directory_too_long_for_its_control_socket(self):
        # A Unix socket path holds about 100 bytes; found in the first-run walkthrough,
        # where the service crashed on "path must be shorter than SUN_LEN" unseen.
        home = self.root / ('long-' * 25) / 'home'
        env = {'WILLCORD_HOME': str(home)}
        for command in (['worker', 'join', 'https://127.0.0.1:1'], ['worker', 'run']):
            with self.subTest(command=command):
                r = self.cli(*command, env=env)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('data directory path is too long', r.stderr)
                self.assertIn('WILLCORD_HOME', r.stderr)
                self.assertNotIn('SUN_LEN', r.stderr)
                self.assertFalse(home.exists(), 'nothing is created in a directory the worker cannot use')
        # Looking at a too-long install (status, uninstall) must keep working.
        r = self.cli('worker', 'status', '--json', env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        # A hand-installed worker names its own data_dir.
        workspace = self.root / 'ws'
        workspace.mkdir()
        config = self.root / 'worker.toml'
        config.write_text(f'worker_id = "w"\ndata_dir = "{self.root / ("long-" * 25)}"\nurl = "wss://127.0.0.1:1/ws/worker"\n[[workspaces]]\nworkspace_id = "repo"\nconfig_version = 1\npath = "{workspace}"\nrepo_id = "local/repo"\nis_default = true\n')
        r = self.cli('worker', 'run', '--config', str(config), env={'WORKER_TOKEN': 'x'})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('data directory path is too long', r.stderr)

    # ------------------------------------------------------------ routing

    def test_commands_are_namespaced(self):
        r = self.cli('version')
        self.assertEqual(r.returncode, 0)
        self.assertTrue(r.stdout.startswith('willcord '))
        for old in ['join', 'install', 'status', 'run']:
            r = self.cli(old)
            self.assertEqual(r.returncode, 2, old)
            self.assertIn('unknown command', r.stderr)
            self.assertIn(f'willcord worker {old}', r.stderr)
        r = self.cli('statsu')
        self.assertEqual(r.returncode, 2)
        self.assertNotIn('你是不是想', r.stderr)
        r = self.cli('worker', 'status', '--json', env={'WILLCORD_HOME': str(self.root / 'worker-home')})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)['state'], 'not_joined')
        r = self.cli('main', 'nope')
        self.assertNotEqual(r.returncode, 0)


if __name__ == '__main__':
    unittest.main()
