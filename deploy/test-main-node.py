#!/usr/bin/env python3
"""Drive `willcord main …` with a fake docker and a local HTTPS /health.

Needs the debug build (cargo build --manifest-path worker/Cargo.toml): its test
seams (WILLCORD_TEST_KEY_STATUS, WILLCORD_TEST_OS) do not exist in release builds.
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

from wizard_pty import BINARY, answers, drive, install_fake_docker

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
                    'TEST_ROOT': str(self.root), 'WILLCORD_TEST_KEY_STATUS': '200', 'WILLCORD_TEST_OS': 'Linux'}
        self.env.pop('SSL_CERT_FILE', None)

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
        self.assertIn('MODEL_API_KEY="key$$with#special"', main_env)
        self.assertIn(f'PUBLIC_BASE_URL="{self.origin}"', main_env)
        self.assertIn(f'WILLCORD_PORT="{self.server.server_port}"', dot_env)
        self.assertIn(f'WILLCORD_SITE="127.0.0.1:{self.server.server_port}"', dot_env)
        self.assertIn('WILLCORD_VERSION="1.2.3"', dot_env)
        self.assertIn('COMPOSE_PROJECT_NAME="willcord-', dot_env)
        self.assertIn('WILLCORD_VERSION:?set WILLCORD_VERSION', (self.deploy / 'compose.yaml').read_text())
        self.assertNotIn('long\'password', out)
        self.assertNotIn('key$with#special', out)
        # The first password goes and main restarts without it.
        self.assertEqual(self.compose_calls(), [['version'], ['pull'], ['up', '-d'], ['cp', 'caddy:/data/caddy/pki/authorities/local/root.crt', './ca.pem'], ['up', '-d', 'main']])
        self.assertTrue((self.deploy / 'willcord').exists(), 'a copy of the binary stays beside the deployment')
        self.assertIn('./willcord main status', out)
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

    def test_model_key_is_checked_before_anything_is_written(self):
        keys = (b'key$with#special\n',) * 3
        code, out = self.init(env={'WILLCORD_TEST_KEY_STATUS': '401'}, answers=self.answers(keys=keys))
        self.assertNotEqual(code, 0, out)
        self.assertIn('拒绝了这个 API key', out)
        self.assertIn('还可再试 2 次', out)
        self.assertIn('连续拒绝了 3 次', out)
        self.assertEqual(list(self.deploy.iterdir()), [], 'a rejected key leaves no config behind')
        self.assertEqual(self.compose_calls(), [['version']])
        # A fixed key can reuse the same directory.
        code, out = self.init()
        self.assertEqual(code, 0, out)
        self.assertIn('API key 检查通过', out)

    def test_a_rejected_key_is_asked_again_without_restarting(self):
        code, out = self.init(env={'WILLCORD_TEST_KEY_STATUS': '401,200'}, answers=self.answers(keys=(b'first-wrong-key\n', b'second-right-key\n')))
        self.assertEqual(code, 0, out)
        self.assertIn('还可再试 2 次', out)
        self.assertIn('API key 检查通过', out)
        self.assertIn('MODEL_API_KEY="second-right-key"', (self.deploy / 'main.env').read_text())

    def test_unconfirmed_model_key_only_warns(self):
        for status in ['403', '500', '000']:
            with self.subTest(status=status):
                shutil.rmtree(self.deploy, ignore_errors=True)
                code, out = self.init(env={'WILLCORD_TEST_KEY_STATUS': status})
                self.assertEqual(code, 0, out)
                self.assertIn('无法确认模型 API key', out)

    def test_provider_is_validated_and_case_insensitive(self):
        code, out = self.init(answers=self.answers(provider=b'OpenRouter \n'))
        self.assertEqual(code, 0, out)
        self.assertIn('MODEL_PROVIDER="openrouter"', (self.deploy / 'main.env').read_text())
        shutil.rmtree(self.deploy)
        answers = [('模型 provider'.encode(), b'openrouterr\n'), ('模型 provider'.encode(), b'openrouter\n'), *self.answers()[1:]]
        code, out = self.init(answers=answers)
        self.assertEqual(code, 0, out)
        self.assertIn('不支持的 provider：openrouterr', out)
        shutil.rmtree(self.deploy)
        code, out = self.init(answers=[('模型 provider'.encode(), b'nope\n')] * 3)
        self.assertNotEqual(code, 0, out)
        self.assertEqual(list(self.deploy.iterdir()), [], 'an unknown provider leaves no config behind')

    def test_only_openrouter_has_a_default_model(self):
        answers = [('模型 provider'.encode(), b'groq\n'), ('模型名称'.encode(), b'\n'), ('模型名称'.encode(), b'llama-3.1-8b-instant\n'), ('模型 API key:'.encode(), b'k\n'), ('管理员密码'.encode(), b"long'password$with#literal\n")]
        code, out = self.init(answers=answers)
        self.assertEqual(code, 0, out)
        self.assertIn('groq 没有默认模型', out)
        self.assertIn('未内置 groq 的 API key 检查', out)
        text = (self.deploy / 'main.env').read_text()
        self.assertIn('MODEL_PROVIDER="groq"', text)
        self.assertIn('MODEL_NAME="llama-3.1-8b-instant"', text)

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
        r = self.cli('main', 'up', cwd=self.root)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('--dir', r.stderr)
        r = subprocess.run([str(self.deploy / 'willcord'), 'main', 'up'], env=self.env, capture_output=True, text=True, cwd=self.root)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.cli('main', 'up', '--dir', str(self.root))
        self.assertNotEqual(r.returncode, 0)

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
        # A certificate the CA did not issue is not trusted.
        self.set_health(True)
        (self.deploy / 'ca.pem').write_text((self.root / 'tls/key.pem').read_text())
        r = self.cli('main', 'status', '--dir', str(self.deploy))
        self.assertNotEqual(r.returncode, 0)

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

    # ------------------------------------------------------------ routing

    def test_commands_are_namespaced(self):
        r = self.cli('version')
        self.assertEqual(r.returncode, 0)
        self.assertTrue(r.stdout.startswith('willcord '))
        for old in ['join', 'install', 'status', 'run']:
            r = self.cli(old)
            self.assertEqual(r.returncode, 2, old)
            self.assertIn('unknown command', r.stderr)
        r = self.cli('worker', 'status', '--json', env={'WILLCORD_HOME': str(self.root / 'worker-home')})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)['state'], 'not_joined')
        r = self.cli('main', 'nope')
        self.assertNotEqual(r.returncode, 0)


if __name__ == '__main__':
    unittest.main()
