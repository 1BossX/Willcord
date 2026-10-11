"""Shared by test-main-node.py and test-compose-env.py: run the real
`willcord main init` on a pty with a fake `docker`, answering its prompts."""
import os
from pathlib import Path
import pty
import select
import sys
import time

BINARY = Path(os.environ.get('WILLCORD_BIN') or Path(__file__).resolve().parent.parent / 'worker/target/debug/willcord')
DOCKER = r'''
import json, os, pathlib, shutil, sys
p=pathlib.Path
args=sys.argv[1:]
root=p(os.environ['TEST_ROOT'])
with (root/'calls').open('a') as f: f.write(json.dumps([args,os.getcwd()])+"\n")
if args[:2]==['compose','version'] and os.environ.get('TEST_NO_COMPOSE')=='1':sys.exit(1)
if args[:1]==['info'] and os.environ.get('TEST_DOCKER_DOWN')=='1':sys.exit(1)
if args[:2]==['compose','pull'] and os.environ.get('TEST_START_FAIL')=='1':sys.exit(1)
if args[:2]==['compose','cp']:shutil.copyfile(root/'tls/cert.pem',args[-1])
'''


def install_fake_docker(bin_dir: Path):
    bin_dir.mkdir(parents=True, exist_ok=True)
    docker = bin_dir / 'docker'
    docker.write_text(f'#!{sys.executable}\n' + DOCKER)
    docker.chmod(0o700)


def answers(provider=b'\n', model=b'\n', keys=(b'key$with#special\n',), password=b"long'password$with#literal\n"):
    return [('模型 provider'.encode(), provider), ('模型名称'.encode(), model), *[('模型 API key:'.encode(), k) for k in keys], ('管理员密码'.encode(), password)]


def drive(argv, env, replies, timeout=30):
    """Run argv on a pty. Each (marker, reply) is sent once its marker has been seen
    after the previous one, so a prompt asked twice gets two replies instead of both
    firing at once. Returns (exit code, terminal output); raises TimeoutError."""
    pid, fd = pty.fork()
    if pid == 0:
        os.execve(argv[0], argv, env)
    output = b''
    sent = cursor = 0
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([fd], [], [], 0.1)
            if readable:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                output += data
                if sent < len(replies):
                    marker, reply = replies[sent]
                    found = output.find(marker, cursor)
                    if found >= 0:
                        os.write(fd, reply)
                        sent += 1
                        cursor = found + len(marker)
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                return os.waitstatus_to_exitcode(status), output.decode()
        # The pty closes slightly before the child can be reaped (slow runners): give it a moment.
        grace = time.monotonic() + 5
        while time.monotonic() < grace:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                return os.waitstatus_to_exitcode(status), output.decode()
            time.sleep(0.05)
        os.kill(pid, 9)
        os.waitpid(pid, 0)
        raise TimeoutError('willcord did not finish: ' + output.decode())
    finally:
        os.close(fd)
