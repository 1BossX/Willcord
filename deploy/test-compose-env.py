#!/usr/bin/env python3
"""Round-trip the first admin password `willcord main init` writes through real Compose containers.

The wizard is the real debug binary (cargo build --manifest-path worker/Cargo.toml)
with a fake docker that fails the first pull, which leaves the generated main.env
behind. Run after deploy/docker/smoke.sh builds local/willcord-main:smoke, or set
COMPOSE_ENV_TEST_IMAGE to an already-built main-node image. No deployment volumes
are mounted and each one-shot container is removed after checking its value.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

from wizard_pty import BINARY, answers, drive, install_fake_docker

# The password must be at least 16 characters, whatever the value under test is.
PAD = 'pad-to-16-chars!'
IMAGE = os.environ.get('COMPOSE_ENV_TEST_IMAGE', 'local/willcord-main:smoke')


class ComposeEnvironmentTests(unittest.TestCase):
    def test_single_line_values_survive_compose_and_container_environment(self):
        values = ["plain", "let's go", r"one\two", "one\\'two", "one'two\\",
                  "one\\\\'two", 'double "quote"', '$VAR ${VAR} $$ #hash',
                  '中文🙂 spaces', '\ttabs\t']
        assert BINARY.exists(), f'build the debug binary first: {BINARY}'
        with tempfile.TemporaryDirectory(prefix='wc-compose-env-') as directory:
            root = Path(directory)
            install_fake_docker(root / 'bin')
            env = {**os.environ, 'LANG': 'en_US.UTF-8', 'PATH': f'{root / "bin"}:{os.environ["PATH"]}',
                   'TEST_ROOT': str(root), 'TEST_START_FAIL': '1'}
            (root / 'probe.yaml').write_text(
                f'services:\n  probe:\n    image: {IMAGE}\n    env_file: main.env\n')
            project = 'wc-env-' + uuid.uuid4().hex[:12]
            try:
                for number, value in enumerate(values):
                    with self.subTest(value=value):
                        deployment = root / f'deployment-{number}'
                        code, out = drive(
                            [str(BINARY), 'main', 'init', '--dir', str(deployment), '--server',
                             'https://127.0.0.1:8443', '--image-version', 'v1.2.3'],
                            env, answers(password=((PAD + value + '\n').encode())))
                        self.assertNotEqual(code, 0, 'the fake docker fails the first pull: ' + out)
                        main_env = deployment / 'main.env'
                        self.assertTrue(main_env.exists(), out)
                        (root / 'main.env').write_text(main_env.read_text())
                        actual = subprocess.check_output(
                            ['docker', 'compose', '-p', project, '-f', str(root / 'probe.yaml'),
                             'run', '--rm', '-T', '--no-deps', '--entrypoint', 'node',
                             'probe', '-e', 'process.stdout.write(process.env.INITIAL_ADMIN_PASSWORD)'], text=True)
                        self.assertEqual(actual, PAD + value)
            finally:
                subprocess.run(['docker', 'compose', '-p', project, '-f', str(root / 'probe.yaml'),
                                'down', '-v', '--remove-orphans'], check=True,
                               stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    unittest.main()
