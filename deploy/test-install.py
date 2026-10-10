#!/usr/bin/env python3
"""Exercise the public installer with offline release, service and Docker fixtures."""
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).with_name('install.sh').resolve()
COMPOSE = SCRIPT.parent / 'docker/compose.yaml'
BASH = '/bin/bash'  # Exercise macOS's stock Bash 3.2 even when Homebrew Bash is on PATH.
STUB = r'''
import hashlib, json, os, pathlib, shutil, sys
p=pathlib.Path
name=p(sys.argv[0]).name
args=sys.argv[1:]
root=p(os.environ['TEST_ROOT'])
def record():
 with (root/'calls').open('a') as f: f.write(json.dumps([name,args])+"\n")
record()
if name=='uname':
 print(os.environ.get('TEST_OS','Linux') if args==['-s'] else os.environ.get('TEST_ARCH','x86_64'))
elif name=='id':
 if len(args)>1 and args[1]=='missing': sys.exit(1)
 print('0' if len(args)>1 and args[1]=='root' else '1000')
elif name=='sudo':
 if args[0]=='env': args=args[1:]
 env=dict(os.environ)
 while args and '=' in args[0]:
  key,value=args.pop(0).split('=',1);env[key]=value
 os.execvpe(args[0],args,env)
elif name=='curl':
 url=next((a for a in args if a.startswith('https://')), '')
 if os.environ.get('TEST_NO_RELEASE')=='1': sys.exit(22)
 if url.endswith('/latest'): print('https://github.com/1BossX/Willcord/releases/tag/v1.2.3',end='');sys.exit()
 dest=p(args[args.index('-o')+1])
 if '/releases/tags/' in url: data=json.dumps({'draft':False,'prerelease':os.environ.get('TEST_PRERELEASE')=='1'}).encode()
 elif url.endswith('/health'): data=b'{"alive":true,"scheduling_ready":true}'
 else:
  asset=url.rsplit('/',1)[-1]
  if os.environ.get('TEST_DOWNLOAD_FAIL')=='1':sys.exit(22)
  source=root/'assets'/asset
  if not source.exists():sys.exit(22)
  data=source.read_bytes()
  if asset.endswith('.sha256') and os.environ.get('TEST_BAD_HASH')=='1':data=b'0'*64+b'  wrong\n'
 dest.write_bytes(data)
elif name=='docker':
 if args[:2]==['compose','pull'] and os.environ.get('TEST_START_FAIL')=='1':sys.exit(1)
 if args[:2]==['compose','cp']:p(args[-1]).write_text('public CA\n')
elif name in ['sleep','systemctl','launchctl']:pass
else:
 if args[0]=='install':
  target=p(os.environ['WORKER_PLANE_SYSTEM_ROOT'])/'bin/worker' if '--system' in args else p(os.environ['WORKER_PLANE_HOME'])/'bin/worker'
  target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(sys.argv[0],target);target.chmod(0o700)
  if '--system' not in args:
   (target.parent.parent/'ca.pem').write_bytes(p(os.environ['SSL_CERT_FILE']).read_bytes())
 elif args[0]=='join':
  assert 'SSL_CERT_FILE' not in os.environ, 'CLI must reuse the saved CA after install'
  print('Node: fixture\nFingerprint: fixture\nAuthorization: pending')
'''

class InstallerTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='wp-install-test-')
  self.root=Path(self.temp.name)
  self.bin=self.root/'bin';self.bin.mkdir()
  self.assets=self.root/'assets';self.assets.mkdir()
  stub=f'#!{sys.executable}\n'+STUB
  for name in ['uname','curl','id','sudo','docker','sleep','systemctl','launchctl']:
   path=self.bin/name;path.write_text(stub);path.chmod(0o700)
  for os_name,arch in [('linux','x86_64'),('linux','aarch64'),('darwin','x86_64'),('darwin','arm64')]:
   self.asset(f'worker-plane-worker-v1.2.3-{os_name}-{arch}',stub.encode())
  self.asset('compose.yaml',COMPOSE.read_bytes())
  self.ca=self.root/"CA directory/o'ne.pem";self.ca.parent.mkdir();self.ca.write_text('CA')
  self.env={**os.environ,'LANG':'en_US.UTF-8','LC_ALL':'en_US.UTF-8','PATH':f'{self.bin}:{os.environ["PATH"]}','TEST_ROOT':str(self.root),'WORKER_PLANE_HOME':str(self.root/"user's data"),'WORKER_PLANE_SYSTEM_ROOT':str(self.root/'system data'),'TMPDIR':str(self.root)}
  self.env.pop('SSL_CERT_FILE',None)
 def tearDown(self):self.temp.cleanup()
 def asset(self,name,data):
  (self.assets/name).write_bytes(data)
  (self.assets/(name+'.sha256')).write_text(hashlib.sha256(data).hexdigest()+'  '+name+'\n')
 def calls(self):return [json.loads(x) for x in (self.root/'calls').read_text().splitlines()]
 def run_worker(self,*extra,env=None):
  return subprocess.run([BASH,str(SCRIPT),'worker','--server','https://plane.internal:8443','--ca',str(self.ca),*extra],env={**self.env,**(env or {})},capture_output=True,text=True)
 def clean_tmp(self):self.assertFalse(list(self.root.glob('worker-plane-install.*')))
 def test_four_platforms_and_literal_paths(self):
  for os_name,arch,asset_os,asset_arch in [('Linux','x86_64','linux','x86_64'),('Linux','arm64','linux','aarch64'),('Darwin','x86_64','darwin','x86_64'),('Darwin','arm64','darwin','arm64')]:
   with self.subTest(os=os_name,arch=arch):
    r=self.run_worker('--version','v1.2.3',env={'TEST_OS':os_name,'TEST_ARCH':arch})
    self.assertEqual(r.returncode,0,r.stderr)
    self.assertTrue(any(asset_os+'-'+asset_arch in str(a) for n,a in self.calls() if n=='curl'))
    self.assertIn("'\\''",r.stdout)
    self.clean_tmp()
 def test_latest_and_system_account(self):
  r=self.run_worker('--system','--user','ops');self.assertEqual(r.returncode,0,r.stderr)
  self.assertIn('安装版本：v1.2.3',r.stdout)
  self.assertTrue((self.root/'system data/bin/worker').exists())
  self.assertTrue(any('--system' in a and 'join' in a for _,a in self.calls()))
 def test_no_release_hash_download_and_account_fail_before_install(self):
  for env,args in [({'TEST_NO_RELEASE':'1'},[]),({'TEST_PRERELEASE':'1'},[]),({'TEST_BAD_HASH':'1'},[]),({'TEST_DOWNLOAD_FAIL':'1'},[]),({},['--system','--user','root']),({},['--system','--user','missing']),({'TEST_ARCH':'riscv64'},[])]:
   with self.subTest(env=env,args=args):
    r=self.run_worker(*args,env=env);self.assertNotEqual(r.returncode,0)
    self.assertFalse((self.root/'user data/bin/worker').exists())
    self.assertFalse((self.root/'system data/bin/worker').exists())
    self.clean_tmp()
 def test_reinstall_preserves_identity_and_ledger(self):
  data=self.root/"user's data";data.mkdir()
  for name in ['identity.pk8','ledger.sqlite']:(data/name).write_text('keep')
  for _ in range(2):
   r=self.run_worker();self.assertEqual(r.returncode,0,r.stderr)
  for name in ['identity.pk8','ledger.sqlite']:self.assertEqual((data/name).read_text(),'keep')
 def main_tty(self,extra=(),env=None):
  pid,fd=pty.fork()
  if pid==0:
   os.execve(BASH,[BASH,str(SCRIPT),'main','--server','https://plane.internal:08443','--dir',str(self.root/'deployment'),*extra],{**self.env,**(env or {})})
  output=b'';prompts=[(b'provider',b'\n'),('模型名称'.encode(),b'\n'),(b'API key',b'key$with#special\n'),('管理员密码'.encode(),b"long'password$with#literal\n")];sent=0;deadline=time.monotonic()+15
  try:
   while time.monotonic()<deadline:
    readable,_,_=select.select([fd],[],[],0.1)
    if readable:
     try:data=os.read(fd,65536)
     except OSError:break
     if not data:break
     output+=data
     if sent<len(prompts) and prompts[sent][0] in output:
      os.write(fd,prompts[sent][1]);sent+=1
    done,status=os.waitpid(pid,os.WNOHANG)
    if done:return os.waitstatus_to_exitcode(status),output.decode()
   done,status=os.waitpid(pid,os.WNOHANG)
   if done:return os.waitstatus_to_exitcode(status),output.decode()
   os.kill(pid,9);os.waitpid(pid,0);self.fail('installer did not finish: '+output.decode())
  finally:os.close(fd)
 def test_main_generates_private_config_and_removes_password(self):
  code,out=self.main_tty();self.assertEqual(code,0,out)
  deploy=self.root/'deployment'
  self.assertEqual((deploy/'main.env').stat().st_mode&0o777,0o600)
  self.assertEqual((deploy/'.env').stat().st_mode&0o777,0o600)
  self.assertNotIn('INITIAL_ADMIN_PASSWORD',(deploy/'main.env').read_text())
  self.assertIn("MODEL_API_KEY='key$with#special'",(deploy/'main.env').read_text())
  self.assertIn("WORKER_PLANE_PORT='8443'",(deploy/'.env').read_text())
  self.assertIn('COMPOSE_PROJECT_NAME=',(deploy/'.env').read_text())
  self.assertEqual((deploy/'ca.pem').stat().st_mode&0o777,0o644)
  self.assertNotIn('long\'password',out)
  self.clean_tmp()
  # Existing config is never replaced.
  before=(deploy/'main.env').read_bytes()
  code,out=self.main_tty();self.assertNotEqual(code,0,out)
  self.assertEqual((deploy/'main.env').read_bytes(),before)
 def test_main_start_failure_keeps_config_and_password_for_recovery(self):
  code,out=self.main_tty(env={'TEST_START_FAIL':'1'});self.assertNotEqual(code,0,out)
  self.assertIn('docker compose logs',out)
  self.assertIn('INITIAL_ADMIN_PASSWORD=',(self.root/'deployment/main.env').read_text())
  self.clean_tmp()

if __name__=='__main__':unittest.main()
