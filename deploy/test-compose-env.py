#!/usr/bin/env python3
"""Round-trip the installer's environment values through real Compose containers.

Run after deploy/docker/smoke.sh builds local/worker-plane-main:smoke, or set
COMPOSE_ENV_TEST_IMAGE to an already-built main-node image. No deployment volumes
are mounted and each one-shot container is removed after checking its value.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

SCRIPT = Path(__file__).with_name('install.sh')
DEFINITIONS = SCRIPT.read_text().rsplit('\nmain "$@"', 1)[0]
IMAGE = os.environ.get('COMPOSE_ENV_TEST_IMAGE', 'local/worker-plane-main:smoke')

class ComposeEnvironmentTests(unittest.TestCase):
    def test_single_line_values_survive_compose_and_container_environment(self):
        values = ["plain", "let's go", r"one\two", "one\\'two", "one'two\\",
                  "one\\\\'two", 'double "quote"', '$VAR ${VAR} $$ #hash',
                  '中文🙂 spaces', '\ttabs\t']
        with tempfile.TemporaryDirectory(prefix='wp-compose-env-') as directory:
            root = Path(directory)
            (root / 'compose.yaml').write_text(
                f'services:\n  probe:\n    image: {IMAGE}\n    env_file: main.env\n')
            project = 'wp-env-' + uuid.uuid4().hex[:12]
            try:
                for value in values:
                    with self.subTest(value=value):
                        line = subprocess.check_output(
                            ['/bin/bash', '-c', DEFINITIONS + '\nenv_line VALUE "$1"',
                             'fixture', value], text=True,
                            env={**os.environ, 'LC_ALL': 'en_US.UTF-8'})
                        (root / 'main.env').write_text(line)
                        actual = subprocess.check_output(
                            ['docker', 'compose', '-p', project, '-f', str(root / 'compose.yaml'),
                             'run', '--rm', '-T', '--no-deps', '--entrypoint', 'node',
                             'probe', '-e', 'process.stdout.write(process.env.VALUE)'], text=True)
                        self.assertEqual(actual, value)
            finally:
                subprocess.run(['docker', 'compose', '-p', project, '-f', str(root / 'compose.yaml'),
                                'down', '-v', '--remove-orphans'], check=True,
                               stdout=subprocess.DEVNULL)

if __name__ == '__main__':
    unittest.main()
