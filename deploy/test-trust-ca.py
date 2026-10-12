#!/usr/bin/env python3
"""Drive `willcord trust-ca` with the real binary against a fake HTTPS main node.

The system trust store is never touched: `sudo`, `security`, `install` and
`update-ca-certificates` are stubs that only record how they were called. Needs the
debug build (cargo build --manifest-path worker/Cargo.toml).
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

from wizard_pty import BINARY, drive

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

# Records every call; `sudo` only records, so the command it would elevate never runs.
RECORDER = r'''
import json, os, pathlib, sys
name=pathlib.Path(sys.argv[0]).name
with (pathlib.Path(os.environ['TEST_ROOT'])/'calls').open('a') as f: f.write(json.dumps([name, sys.argv[1:]])+"\n")
'''

PROMPT = '请输入从已信任或独立渠道取得的指纹'
DEBIAN = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n'
FEDORA = 'NAME="Fedora Linux"\nID=fedora\n'


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
        if self.path == '/health':
            self.reply(200, b'{"alive":true,"scheduling_ready":true}', [('Content-Type', 'application/json')])
        elif self.path == '/.well-known/willcord/ca.pem':
            mode = self.server.mode
            if mode == 'redirect':
                self.reply(302, headers=[('Location', '/health')])
            elif mode == 'huge':
                self.reply(200, b'x' * 70000)
            elif mode == 'two':
                self.reply(200, self.server.pem + self.server.pem)
            elif mode == 'other':
                self.reply(200, self.server.other)
            else:
                self.reply(200, self.server.pem)
        else:
            self.reply(404)

    def log_message(self, *a): pass


def openssl(*args):
    subprocess.run(['openssl', *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def der_fingerprint(pem_path):
    der = subprocess.check_output(['openssl', 'x509', '-in', str(pem_path), '-outform', 'DER'])
    return hashlib.sha256(der).hexdigest()


class TrustCaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert BINARY.exists(), f'build the debug binary first: {BINARY}'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wct-')
        self.root = Path(self.temp.name)
        tls = self.root / 'tls'
        tls.mkdir()
        config = tls / 'openssl.cnf'
        config.write_text(TLS_CONFIG)
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(tls / 'key.pem'), '-out', str(tls / 'cert.pem'), '-days', '1', '-config', str(config))
        openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(tls / 'other-key.pem'), '-out', str(tls / 'other.pem'), '-days', '1', '-subj', '/CN=another-root')
        self.pin = der_fingerprint(tls / 'cert.pem')
        self.other_pin = der_fingerprint(tls / 'other.pem')
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(tls / 'cert.pem', tls / 'key.pem')
        self.server = http.server.HTTPServer(('127.0.0.1', 0), Node)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        self.server.pem = (tls / 'cert.pem').read_bytes()
        self.server.other = (tls / 'other.pem').read_bytes()
        self.server.mode = 'normal'
        self.server.log = []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f'https://127.0.0.1:{self.server.server_port}'
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        for name in ['sudo', 'security', 'install', 'update-ca-certificates']:
            stub = bin_dir / name
            stub.write_text(f'#!{sys.executable}\n' + RECORDER)
            stub.chmod(0o700)
        self.os_release = self.root / 'os-release'
        self.os_release.write_text(DEBIAN)
        self.data = self.root / 'data'
        self.home = self.root / 'home'
        self.home.mkdir()
        self.env = {**os.environ, 'LANG': 'en_US.UTF-8', 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'TEST_ROOT': str(self.root),
                    'HOME': str(self.home), 'WILLCORD_HOME': str(self.data), 'WILLCORD_TEST_OS': 'Darwin',
                    'WILLCORD_TEST_OS_RELEASE': str(self.os_release)}
        self.env.pop('WILLCORD_SYSTEM_ROOT', None)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def run_trust(self, *args, url=None, env=None, stdin=subprocess.DEVNULL):
        return subprocess.run([str(BINARY), 'trust-ca', url or self.origin, *args], env={**self.env, **(env or {})},
                              stdin=stdin, capture_output=True, text=True, timeout=120)

    def commands(self):
        """Every system command asked for, without the sudo that elevated it."""
        path = self.root / 'calls'
        calls = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [args if name == 'sudo' else [name, *args] for name, args in calls]

    def requested(self):
        return [p for _, p in self.server.log]

    def stored(self, fingerprint=None):
        return self.data / 'trusted-ca' / f'{fingerprint or self.pin}.pem'

    def trusted_files(self):
        directory = self.data / 'trusted-ca'
        return sorted(p.name for p in directory.iterdir()) if directory.exists() else []

    def assert_nothing_imported(self, r):
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.commands(), [])
        self.assertEqual(self.trusted_files(), [])

    # ----------------------------------------------------------- the happy path

    def test_a_link_fingerprint_is_checked_then_the_root_is_imported_once(self):
        r = self.run_trust(url=f'{self.origin}#sha256={self.pin.upper()}')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('CA 指纹已核对', r.stdout)
        self.assertIn('HTTPS 校验通过', r.stdout)
        self.assertIn('Firefox', r.stdout)
        # Exactly two requests: the unverified root fetch, then /health, which only
        # a client trusting that root can complete.
        self.assertEqual(self.server.log, [('GET', '/.well-known/willcord/ca.pem'), ('GET', '/health')])
        stored = self.stored()
        self.assertEqual(self.trusted_files(), [stored.name])
        self.assertEqual(stored.read_text().split(), self.server.pem.decode().split())
        self.assertEqual(self.commands(), [['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', str(stored)]])

    def test_a_flag_fingerprint_works_the_same_as_the_link_fragment(self):
        r = self.run_trust('--ca-fingerprint', self.pin)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(self.commands()), 1)

    def test_a_repeat_run_leaves_one_stored_root_and_asks_for_the_same_steps(self):
        url = f'{self.origin}#sha256={self.pin}'
        self.assertEqual(self.run_trust(url=url).returncode, 0)
        first = self.commands()
        self.assertEqual(self.run_trust(url=url).returncode, 0)
        self.assertEqual(self.commands(), first * 2)
        self.assertEqual(self.trusted_files(), [f'{self.pin}.pem'])

    def test_debian_installs_a_named_anchor_and_refreshes_the_store(self):
        r = self.run_trust(url=f'{self.origin}#sha256={self.pin}', env={'WILLCORD_TEST_OS': 'Linux'})
        self.assertEqual(r.returncode, 0, r.stderr)
        stored = self.stored()
        self.assertEqual(self.commands(), [
            ['install', '-m', '0644', str(stored), f'/usr/local/share/ca-certificates/willcord-ca-{self.pin[:16]}.crt'],
            ['update-ca-certificates'],
        ])

    def test_other_linux_prints_the_steps_and_runs_nothing(self):
        self.os_release.write_text(FEDORA)
        r = self.run_trust(url=f'{self.origin}#sha256={self.pin}', env={'WILLCORD_TEST_OS': 'Linux'})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.commands(), [])
        self.assertIn('update-ca-trust', r.stdout)
        self.assertIn(str(self.stored()), r.stdout)
        self.assertIn('Firefox', r.stdout)

    # ----------------------------------------------------- what must stop it

    def test_a_root_that_does_not_match_the_fingerprint_imports_nothing(self):
        r = self.run_trust('--ca-fingerprint', '0' * 64)
        self.assertIn('指纹不匹配', r.stderr)
        self.assert_nothing_imported(r)
        self.assertEqual(self.requested(), ['/.well-known/willcord/ca.pem'])

    def test_a_root_that_does_not_verify_the_main_node_is_removed_again(self):
        self.server.mode = 'other'
        r = self.run_trust('--ca-fingerprint', self.other_pin)
        self.assertIn('无法通过 CA 验证主节点 HTTPS', r.stderr)
        self.assert_nothing_imported(r)
        # The TLS handshake failed before any application request reached the node.
        self.assertEqual(self.requested(), ['/.well-known/willcord/ca.pem'])

    def test_a_bad_root_response_is_refused_before_any_check(self):
        for mode in ['huge', 'two', 'redirect']:
            with self.subTest(mode=mode):
                self.server.mode = mode
                self.server.log.clear()
                r = self.run_trust('--ca-fingerprint', self.pin)
                self.assert_nothing_imported(r)
                self.assertNotIn('/health', self.requested())

    def test_without_a_fingerprint_nothing_is_fetched_unless_a_terminal_can_confirm(self):
        r = self.run_trust()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('非交互环境直接拒绝', r.stderr)
        self.assertIn('已信任或独立渠道', r.stderr)
        self.assertNotIn('管理员渠道', r.stderr)
        self.assertEqual(self.requested(), [])
        self.assert_nothing_imported(r)

    def test_a_typed_fingerprint_confirms_the_import_from_a_terminal(self):
        replies = [(PROMPT.encode(), (self.pin.upper() + '\n').encode())]
        code, output = drive([str(BINARY), 'trust-ca', self.origin], self.env, replies)
        self.assertEqual(code, 0, output)
        self.assertIn(self.pin, output)
        self.assertIn('已信任或独立的渠道', output)
        self.assertNotIn('管理员渠道', output)
        self.assertIn('不能证明证书可信', output)
        self.assertEqual(len(self.commands()), 1)

    def test_a_system_trusted_root_cannot_pass_the_check_or_be_imported(self):
        # The machine trusts the main node's leaf (cert.pem) as a root, while the
        # published root is other.pem. Adding the saved root on top of the system roots
        # would let /health pass through the system root; trust-ca must not.
        self.env['SSL_CERT_FILE'] = str(self.root / 'tls' / 'cert.pem')
        self.server.mode = 'other'
        r = self.run_trust('--ca-fingerprint', self.other_pin)
        self.assertIn('无法通过 CA 验证主节点 HTTPS', r.stderr)
        self.assert_nothing_imported(r)
        self.assertEqual(self.requested(), ['/.well-known/willcord/ca.pem'])

    def test_a_different_or_empty_typed_fingerprint_imports_nothing(self):
        for answer in [self.other_pin + '\n', '\n']:
            with self.subTest(answer=answer):
                self.server.log.clear()
                code, output = drive([str(BINARY), 'trust-ca', self.origin], self.env, [(PROMPT.encode(), answer.encode())])
                self.assertNotEqual(code, 0, output)
                self.assertEqual(self.commands(), [])
                self.assertEqual(self.trusted_files(), [])

    def test_bad_invocations_change_nothing(self):
        cases = [
            [],
            ['--ca-fingerprint'],
            [self.origin, 'extra'],
            ['--ca-fingerprint', 'abc', self.origin],
            ['--ca-fingerprint', self.pin, f'{self.origin}#sha256={self.pin}'],
            ['--ca-fingerprint', self.pin, 'http://127.0.0.1:1'],
            ['--ca-fingerprint', self.pin, 'https://127.0.0.1:1/path'],
        ]
        for args in cases:
            with self.subTest(args=args):
                r = subprocess.run([str(BINARY), 'trust-ca', *args], env=self.env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
                self.assertNotEqual(r.returncode, 0, r.stdout)
                self.assert_nothing_imported(r)
                self.assertEqual(self.requested(), [])


if __name__ == '__main__':
    unittest.main()
