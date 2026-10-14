#!/usr/bin/env python3
"""Caddy edge cases for #91: shared routes, wrong-Host listener, public PEM endpoints."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
ROUTES = ROOT / 'deploy/caddy/willcord-routes.caddy'


class CaddyEdgeConfigTests(unittest.TestCase):
    def test_shared_routes_expose_ca_chain_and_wrong_host_page(self):
        text = ROUTES.read_text()
        self.assertIn('willcord_wrong_host', text)
        self.assertIn('421', text)
        self.assertIn('/.well-known/willcord/ca.pem', text)
        self.assertIn('/.well-known/willcord/chain.pem', text)
        self.assertIn('intermediate.crt', text)

    def test_production_and_docker_import_shared_routes(self):
        for name in ('deploy/Caddyfile.production', 'deploy/docker/Caddyfile'):
            body = (ROOT / name).read_text()
            self.assertIn('willcord-routes.caddy', body)
            self.assertIn('willcord_wrong_host', body)

    def test_caddyfile_validates_in_docker_when_available(self):
        try:
            subprocess.run(['docker', 'info'], capture_output=True, check=True, timeout=10)
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            self.skipTest('docker not available')
        dockerfile = ROOT / 'deploy/docker/Dockerfile'
        tag = 'willcord-caddy-config-test'
        subprocess.run(
            ['docker', 'build', '-f', str(dockerfile), '--target', 'caddy', '-t', tag, str(ROOT)],
            check=True,
            capture_output=True,
            text=True,
        )
        proc = subprocess.run(
            ['docker', 'run', '--rm', '-e', 'WILLCORD_SITE=localhost:8443', tag,
             'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)


if __name__ == '__main__':
    unittest.main()
