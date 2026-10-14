#!/usr/bin/env python3
"""Caddy edge cases for #91: shared routes, wrong-Host listener, public PEM endpoints."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
ROUTES = ROOT / 'deploy/caddy/willcord-routes.caddy'
VALIDATE = ROOT / 'deploy/caddy-validate.sh'


class CaddyEdgeConfigTests(unittest.TestCase):
    def test_wrong_host_uses_heredoc_status_after_marker(self):
        text = ROUTES.read_text()
        self.assertIn('respond <<HTML', text)
        self.assertRegex(text, r'\nHTML 421\n')

    def test_shared_routes_expose_ca_chain_and_baremetal_ui(self):
        text = ROUTES.read_text()
        self.assertIn('willcord_wrong_host', text)
        self.assertIn('willcord_baremetal', text)
        self.assertIn('/.well-known/willcord/ca.pem', text)
        self.assertIn('/.well-known/willcord/chain.pem', text)
        self.assertIn('intermediate.crt', text)
        self.assertIn('{$WILLCORD_ROOT}/apps/web/dist', text)
        self.assertIn('/var/lib/caddy/.local/share/caddy/pki/authorities/local', text)

    def test_production_uses_baremetal_without_port_catchall(self):
        production = (ROOT / 'deploy/Caddyfile.production').read_text()
        self.assertIn('willcord_baremetal', production)
        self.assertNotIn('WILLCORD_PORT', production)
        self.assertNotIn(':{$WILLCORD_PORT', production)

    def test_docker_keeps_wrong_host_listener(self):
        docker = (ROOT / 'deploy/docker/Caddyfile').read_text()
        self.assertIn(':{$WILLCORD_PORT', docker)
        self.assertIn('willcord_wrong_host', docker)

    def test_caddy_validate_without_docker(self):
        proc = subprocess.run(['bash', str(VALIDATE)], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)


if __name__ == '__main__':
    unittest.main()
