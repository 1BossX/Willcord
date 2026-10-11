#!/usr/bin/env python3
"""Drive `willcord worker join URL` with the real binary against a fake main node.

One command installs the service, trusts the main node's CA and files the join
request. Needs the debug build (cargo build --manifest-path worker/Cargo.toml).
launchctl and systemctl are stubs, so nothing is registered on this machine.
"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest

from wizard_pty import BINARY

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

# A service manager that accepts everything and reports nothing as running,
# except the login session the installer checks for first.
SERVICE_STUB = r'''
import json, os, pathlib, sys
args=sys.argv[1:]
with (pathlib.Path(os.environ['TEST_ROOT'])/'calls').open('a') as f: f.write(json.dumps([pathlib.Path(sys.argv[0]).name,args])+"\n")
name=pathlib.Path(sys.argv[0]).name
if name=='launchctl' and args[:1]==['print'] and 'willcord' in args[1]: sys.exit(1)
if name=='systemctl' and 'is-active' in args: sys.exit(3)
'''


class Node(http.server.BaseHTTPRequestHandler):
    def reply(self, status, body=b'', headers=()):
        self.server.log.append((self.command, self.path))
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        mode = self.server.mode
        if self.path == '/health':
            self.reply(200, b'{"alive":true,"scheduling_ready":true}')
        elif self.path == '/.well-known/willcord/ca.pem':
            if mode == 'redirect':
                self.reply(302, headers=[('Location', '/health')])
            elif mode == 'huge':
                self.reply(200, b'x' * 70000)
            elif mode == 'two':
                self.reply(200, self.server.pem + self.server.pem)
            else:
                self.reply(200, self.server.pem)
        else:
            self.reply(404)

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if self.path == '/enrollment/challenge':
            self.reply(200, b'{"challenge":"c1"}', [('Content-Type', 'application/json')])
        elif self.path == '/enrollment/apply':
            self.reply(200, json.dumps({'state': self.server.state, 'worker_id': 'w1'}).encode(), [('Content-Type', 'application/json')])
        else:
            self.reply(404, b'{}', [('Content-Type', 'application/json')])

    def log_message(self, *a): pass


class WorkerJoinTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert BINARY.exists(), f'build the debug binary first: {BINARY}'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wcj-')
        self.root = Path(self.temp.name)
        (self.root / 'tls').mkdir()
        config = self.root / 'tls/openssl.cnf'
        config.write_text(TLS_CONFIG)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(self.root / 'tls/key.pem'), '-out', str(self.root / 'tls/cert.pem'), '-days', '1', '-config', str(config)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        der = subprocess.check_output(['openssl', 'x509', '-in', str(self.root / 'tls/cert.pem'), '-outform', 'DER'])
        self.pin = hashlib.sha256(der).hexdigest()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.root / 'tls/cert.pem', self.root / 'tls/key.pem')
        self.server = http.server.HTTPServer(('127.0.0.1', 0), Node)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.server.pem = (self.root / 'tls/cert.pem').read_bytes()
        self.server.mode = 'normal'
        self.server.state = 'pending'
        self.server.log = []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f'https://127.0.0.1:{self.server.server_port}'
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        for name in ['launchctl', 'systemctl']:
            stub = bin_dir / name
            stub.write_text(f'#!{sys.executable}\n' + SERVICE_STUB)
            stub.chmod(0o700)
        self.home = self.root / 'home'
        self.home.mkdir()
        self.data = self.root / 'data'
        self.agents = self.root / 'agents'
        self.env = {**os.environ, 'LANG': 'en_US.UTF-8', 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'TEST_ROOT': str(self.root),
                    'HOME': str(self.home), 'WILLCORD_HOME': str(self.data), 'WILLCORD_LAUNCH_AGENT_DIR': str(self.agents)}
        for name in ['SSL_CERT_FILE', 'WILLCORD_SYSTEM_ROOT']:
            self.env.pop(name, None)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def join(self, *args, url=None, env=None, binary=None):
        return subprocess.run([str(binary or BINARY), 'worker', 'join', url or self.origin, *args], env={**self.env, **(env or {})}, capture_output=True, text=True, timeout=120)

    def calls(self):
        path = self.root / 'calls'
        return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []

    def requested(self, path):
        return [p for _, p in self.server.log if p == path]

    def assert_nothing_installed(self):
        self.assertFalse((self.data / 'bin/willcord').exists())
        self.assertFalse((self.home / '.local/bin/willcord').exists())
        self.assertFalse(self.agents.exists() and any(self.agents.iterdir()))
        self.assertEqual([a for _, a in self.calls() if a[:1] == ['bootstrap']], [])

    # -------------------------------------------------------------- pinning

    def test_the_pinned_certificate_is_the_only_trust(self):
        r = self.join('--ca-fingerprint', self.pin)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('CA 指纹已核对', r.stdout)
        # Installed for the account that ran it, and on PATH.
        self.assertEqual((self.data / 'bin/willcord').read_bytes(), BINARY.read_bytes())
        self.assertEqual((self.home / '.local/bin/willcord').read_bytes(), BINARY.read_bytes())
        self.assertEqual((self.data / 'ca.pem').read_bytes(), self.server.pem.replace(b'\r', b''))
        self.assertEqual(json.loads((self.data / 'enrollment.json').read_text())['url'], self.origin)
        # The service was registered, and the request filed through the installed copy.
        self.assertTrue(any(a[:1] == ['bootstrap'] or 'enable' in a for _, a in self.calls()), self.calls())
        self.assertIn('Authorization: pending', r.stdout)
        self.assertIn('Status: willcord worker status --json', r.stdout)
        # The first contact is the only request that skips verification: it was
        # made once, and no temporary certificate is left behind.
        self.assertEqual(len(self.requested('/.well-known/willcord/ca.pem')), 1)
        self.assertEqual([p for p in Path(tempfile_dir()).glob('willcord-ca-*.pem')], [])

    def test_a_wrong_or_malformed_answer_installs_nothing(self):
        r = self.join('--ca-fingerprint', '0' * 64)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('指纹不匹配', r.stderr)
        self.assert_nothing_installed()
        for mode in ['huge', 'two', 'redirect']:
            with self.subTest(mode=mode):
                self.server.mode = mode
                r = self.join('--ca-fingerprint', self.pin)
                self.assertNotEqual(r.returncode, 0, mode)
                self.assert_nothing_installed()
        # Not even a request to the health check or enrollment followed.
        self.assertEqual(self.requested('/health'), [])
        self.assertEqual([p for m, p in self.server.log if m == 'POST'], [])
        for bad in ['0' * 63, 'z' * 64]:
            r = self.join('--ca-fingerprint', bad)
            self.assertNotEqual(r.returncode, 0, bad)
        self.assert_nothing_installed()

    def test_an_untrusted_main_node_is_refused_before_installing(self):
        r = self.join()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('无法通过 CA 验证主节点 HTTPS', r.stderr)
        self.assert_nothing_installed()
        self.assertEqual([p for m, p in self.server.log if m == 'POST'], [])

    def test_a_ca_file_is_used_without_any_unverified_request(self):
        ca = self.root / 'tls/cert.pem'
        r = self.join('--ca', str(ca))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.data / 'ca.pem').read_bytes(), ca.read_bytes())
        self.assertEqual(self.requested('/.well-known/willcord/ca.pem'), [])
        for args in [['--ca', 'relative.pem'], ['--ca', str(self.root / 'missing.pem')], ['--ca', str(ca), '--ca-fingerprint', self.pin]]:
            r = self.join(*args)
            self.assertNotEqual(r.returncode, 0, args)

    # ------------------------------------------------------------ re-running

    def test_joining_again_from_the_installed_copy_does_not_touch_the_service(self):
        self.assertEqual(self.join('--ca-fingerprint', self.pin).returncode, 0)
        before = len(self.calls())
        self.server.state = 'approved'
        for binary in [self.data / 'bin/willcord', self.home / '.local/bin/willcord', BINARY]:
            r = self.join(binary=binary)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('Authorization: approved', r.stdout)
            self.assertIn('无需再次批准', r.stdout)
        self.assertEqual(len(self.calls()), before, 'no service call: the installed build is the running build')

    def test_a_newer_build_replaces_the_service_copy_and_keeps_the_identity(self):
        self.assertEqual(self.join('--ca-fingerprint', self.pin).returncode, 0)
        identity = (self.data / 'identity.pk8').read_bytes()
        newer = self.root / 'newer'
        newer.write_bytes(BINARY.read_bytes() + b'\0newer build')
        newer.chmod(0o755)
        r = self.join(binary=newer)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.data / 'bin/willcord').read_bytes(), newer.read_bytes())
        self.assertEqual((self.home / '.local/bin/willcord').read_bytes(), newer.read_bytes())
        self.assertEqual((self.data / 'identity.pk8').read_bytes(), identity)
        self.assertIn('已更新命令', r.stdout)

    # ------------------------------------------------------------- arguments

    def test_bad_invocations_fail_before_anything_changes(self):
        for url in ['http://127.0.0.1:1', 'https://127.0.0.1:1/path', 'nonsense']:
            r = self.join(url=url)
            self.assertNotEqual(r.returncode, 0, url)
        r = self.join('--system', '--user', 'nobody-here', '--ca-fingerprint', self.pin)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('root', r.stderr)
        r = self.join('--user', 'someone', '--ca-fingerprint', self.pin)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('--system', r.stderr)
        self.assert_nothing_installed()

    def test_uninstall_leaves_the_command_and_says_how_to_remove_it(self):
        self.assertEqual(self.join('--ca-fingerprint', self.pin).returncode, 0)
        r = subprocess.run([str(self.home / '.local/bin/willcord'), 'worker', 'uninstall', '--delete-data'], env=self.env, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(self.data.exists())
        self.assertTrue((self.home / '.local/bin/willcord').exists())
        self.assertIn('willcord self-uninstall', r.stdout)
        r = subprocess.run([str(self.home / '.local/bin/willcord'), 'self-uninstall'], env=self.env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((self.home / '.local/bin/willcord').exists())


def tempfile_dir():
    return tempfile.gettempdir()


if __name__ == '__main__':
    unittest.main()
