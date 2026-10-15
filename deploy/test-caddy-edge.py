#!/usr/bin/env python3
"""Caddy edge cases for #91: shared routes, wrong-Host listener, public PEM endpoints.

#100: bare-metal defaults derive from WILLCORD_ROOT (no Docker container paths).
#105: caddy-validate.sh picks the Caddy asset name per OS (Darwin uses mac).
"""
from pathlib import Path
import json
import os
import platform
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
ROUTES = ROOT / 'deploy/caddy/willcord-routes.caddy'
VALIDATE = ROOT / 'deploy/caddy-validate.sh'
CA_ROOT_BAREMETAL = '/var/lib/caddy/.local/share/caddy/pki/authorities/local'
CA_ROOT_DOCKER = '/data/caddy/pki/authorities/local'


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


def caddy_version():
    return os.environ.get('CADDY_VERSION', '2.10.2')


def artifact_url(uname_s, uname_m):
    """Artifact URL caddy-validate.sh would download for injected uname results."""
    env = dict(os.environ,
               CADDY_VALIDATE_PRINT_URL='1',
               CADDY_VALIDATE_UNAME_S=uname_s,
               CADDY_VALIDATE_UNAME_M=uname_m)
    proc = subprocess.run(['bash', str(VALIDATE)], capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout + proc.stderr)
    return proc.stdout.strip()


class CaddyValidateAssetTests(unittest.TestCase):
    def test_darwin_downloads_mac_asset_not_darwin(self):
        url = artifact_url('Darwin', 'arm64')
        self.assertIn(f'caddy_{caddy_version()}_mac_arm64.tar.gz', url)
        self.assertNotIn('_darwin_', url)

    def test_linux_downloads_linux_asset(self):
        url = artifact_url('Linux', 'x86_64')
        self.assertIn(f'caddy_{caddy_version()}_linux_amd64.tar.gz', url)
        self.assertNotIn('_mac_', url)

    def test_aarch64_maps_to_arm64(self):
        self.assertIn('_mac_arm64.tar.gz', artifact_url('Darwin', 'aarch64'))
        self.assertIn('_linux_arm64.tar.gz', artifact_url('Linux', 'aarch64'))

    def test_x86_64_maps_to_amd64_on_darwin(self):
        self.assertIn('_mac_amd64.tar.gz', artifact_url('Darwin', 'x86_64'))

    def test_unsupported_os_is_refused(self):
        env = dict(os.environ, CADDY_VALIDATE_PRINT_URL='1', CADDY_VALIDATE_UNAME_S='SunOS')
        proc = subprocess.run(['bash', str(VALIDATE)], capture_output=True, text=True, env=env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('unsupported OS: SunOS', proc.stderr)


def os_name():
    return {'Linux': 'linux', 'Darwin': 'mac'}.get(platform.system(), platform.system().lower())


def caddy_bin():
    """Caddy binary from the caddy-validate.sh cache; downloads it on first use."""
    machine = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine(), platform.machine())
    cache = Path(os.environ.get('CADDY_VALIDATE_CACHE', '/tmp/willcord-caddy-validate'))
    bin_path = cache / f'caddy-{caddy_version()}-{os_name()}-{machine}'
    if not (bin_path.is_file() and os.access(bin_path, os.X_OK)):
        proc = subprocess.run(['bash', str(VALIDATE)], capture_output=True, text=True)
        if proc.returncode != 0:
            raise AssertionError(proc.stdout + proc.stderr)
    return bin_path if bin_path.is_file() else None


def adapt(config, env, cwd=None):
    """Adapt a Caddyfile with caddy adapt and return the parsed JSON."""
    proc = subprocess.run([str(caddy_bin()), 'adapt', '--config', str(config),
                           '--adapter', 'caddyfile'],
                          capture_output=True, text=True, env={**os.environ, **env}, cwd=cwd)
    if proc.returncode != 0:
        raise AssertionError(proc.stderr)
    return json.loads(proc.stdout)


def root_values(data):
    roots = []

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == 'root' and isinstance(value, str):
                    roots.append(value)
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(data)
    return roots


class CaddyDerivedDefaultsTests(unittest.TestCase):
    """#100: bare-metal defaults with only WILLCORD_SITE + WILLCORD_ROOT set."""

    def setUp(self):
        if caddy_bin() is None:
            self.skipTest('caddy binary unavailable')

    def stage_release(self):
        release = tempfile.mkdtemp(prefix='willcord-adapt-')
        self.addCleanup(shutil.rmtree, release, ignore_errors=True)
        routes = Path(release) / 'deploy/caddy'
        routes.mkdir(parents=True)
        (routes / 'willcord-routes.caddy').write_text(ROUTES.read_text())
        (Path(release) / 'deploy/Caddyfile.production').write_text(
            (ROOT / 'deploy/Caddyfile.production').read_text())
        return release

    def test_baremetal_derives_ui_and_pem_roots_from_willcord_root(self):
        release = self.stage_release()
        data = adapt(Path(release) / 'deploy/Caddyfile.production',
                     {'WILLCORD_SITE': 'plane.internal:8443', 'WILLCORD_ROOT': release})
        roots = root_values(data)
        self.assertIn(f'{release}/apps/web/dist', roots)
        self.assertIn(CA_ROOT_BAREMETAL, roots)
        self.assertNotIn('/srv/web', roots)
        self.assertNotIn(CA_ROOT_DOCKER, roots)

    def test_baremetal_has_no_wrong_host_catchall_listener(self):
        release = self.stage_release()
        data = adapt(Path(release) / 'deploy/Caddyfile.production',
                     {'WILLCORD_SITE': 'plane.internal:8443', 'WILLCORD_ROOT': release})
        listeners = [listen for server in data['apps']['http']['servers'].values()
                     for listen in server['listen']]
        self.assertEqual(listeners, [':8443'])

    def test_docker_entrypoint_defaults_unchanged(self):
        stage = tempfile.mkdtemp(prefix='willcord-docker-adapt-')
        self.addCleanup(shutil.rmtree, stage, ignore_errors=True)
        etc_caddy = Path(stage) / 'etc/caddy'
        etc_caddy.mkdir(parents=True)
        (etc_caddy / 'willcord-routes.caddy').write_text(ROUTES.read_text())
        # Same staging caddy-validate.sh uses: the docker Caddyfile imports
        # /etc/caddy/willcord-routes.caddy in the container.
        caddyfile = etc_caddy / 'Caddyfile'
        caddyfile.write_text((ROOT / 'deploy/docker/Caddyfile').read_text()
                             .replace('import /etc/caddy/willcord-routes.caddy',
                                      'import willcord-routes.caddy'))
        data = adapt(caddyfile, {
            'WILLCORD_SITE': 'plane.internal:8443',
            'WILLCORD_HOST': 'plane.internal', 'WILLCORD_PORT': '8443',
            'WILLCORD_LOCAL_PORT': '8480', 'WILLCORD_ORIGIN': 'https://plane.internal:8443',
            'WILLCORD_UPSTREAM': 'main:3000',
            'WILLCORD_WEB_ROOT': '/srv/web', 'WILLCORD_CA_ROOT': CA_ROOT_DOCKER,
        }, cwd=etc_caddy)
        roots = root_values(data)
        self.assertIn('/srv/web', roots)
        self.assertIn(CA_ROOT_DOCKER, roots)
        listeners = {listen for server in data['apps']['http']['servers'].values()
                     for listen in server['listen']}
        self.assertEqual(listeners, {':8443', ':8480'})


if __name__ == '__main__':
    unittest.main()
