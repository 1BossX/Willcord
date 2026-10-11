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
 if url.endswith('/latest'): print('https://github.com/1BossX/Willcord/releases' if os.environ.get('TEST_NO_LATEST')=='1' else 'https://github.com/1BossX/Willcord/releases/tag/v1.2.3',end='');sys.exit()
 dest=p(args[args.index('-o')+1]) if '-o' in args else None
 if '/releases/tags/' in url and os.environ.get('TEST_API_LIMIT')=='1': sys.exit(22)
 if url.startswith('https://openrouter.ai/'):
  code=os.environ.get('TEST_KEY_STATUS','200');sys.stdout.write(code if '--write-out' in args else '');sys.exit(0)
 if '/releases/tags/' in url: data=json.dumps({'draft':False,'prerelease':os.environ.get('TEST_PRERELEASE')=='1'}).encode()
 elif url.endswith('/.well-known/willcord/ca.pem'): data=(root/'bootstrap.pem').read_bytes()
 elif url.endswith('/health') and os.environ.get('TEST_TLS_FAIL')=='1':sys.exit(60)
 elif url.endswith('/health'): data=b'{"alive":true,"scheduling_ready":true}'
 else:
  asset=url.rsplit('/',1)[-1]
  if os.environ.get('TEST_DOWNLOAD_FAIL')=='1':sys.exit(22)
  source=root/'assets'/asset
  if not source.exists():sys.exit(22)
  data=source.read_bytes()
  if asset.endswith('.sha256') and os.environ.get('TEST_BAD_HASH')=='1':data=b'0'*64+b'  wrong\n'
 if dest is not None:dest.write_bytes(data)
 else:sys.stdout.buffer.write(data)
elif name=='docker':
 if args[:2]==['compose','pull'] and os.environ.get('TEST_START_FAIL')=='1':sys.exit(1)
 if args[:2]==['compose','cp']:p(args[-1]).write_text('public CA\n')
elif name in ['sleep','systemctl','launchctl']:pass
else:
 if args[0]=='install':
  target=p(os.environ['WORKER_PLANE_SYSTEM_ROOT'])/'bin/worker' if '--system' in args else p(os.environ['WORKER_PLANE_HOME'])/'bin/worker'
  target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(sys.argv[0],target);target.chmod(0o700)
  if '--system' not in args and 'SSL_CERT_FILE' in os.environ:
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
  self.asset('worker-plane-worker-v1.2.3-rc.1-linux-x86_64',stub.encode())
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
  self.assertTrue((Path(self.env['WORKER_PLANE_SYSTEM_ROOT'])/'bin/worker').exists())
  self.assertTrue(any('--system' in a and 'join' in a for _,a in self.calls()))
 def test_no_release_hash_download_and_account_fail_before_install(self):
  for env,args in [({'TEST_NO_RELEASE':'1'},[]),({'TEST_PRERELEASE':'1'},['--version','v1.2.3']),({'TEST_BAD_HASH':'1'},[]),({'TEST_DOWNLOAD_FAIL':'1'},[]),({},['--system','--user','root']),({},['--system','--user','missing']),({'TEST_ARCH':'riscv64'},[])]:
   with self.subTest(env=env,args=args):
    r=self.run_worker(*args,env=env);self.assertNotEqual(r.returncode,0)
    self.assertFalse((Path(self.env['WORKER_PLANE_HOME'])/'bin/worker').exists())
    self.assertFalse((Path(self.env['WORKER_PLANE_SYSTEM_ROOT'])/'bin/worker').exists())
    self.clean_tmp()
 def test_prerelease_only_when_named(self):
  r=self.run_worker('--version','v1.2.3-rc.1',env={'TEST_PRERELEASE':'1'});self.assertEqual(r.returncode,0,r.stderr)
  self.assertIn('安装预发布版本：v1.2.3-rc.1',r.stdout)
  self.assertTrue(any('worker-plane-worker-v1.2.3-rc.1-linux-x86_64' in str(a) for n,a in self.calls() if n=='curl'))
  self.clean_tmp()
  r=self.run_worker('--version','v1.2.3',env={'TEST_PRERELEASE':'1'});self.assertNotEqual(r.returncode,0)
  self.assertIn('预发布',r.stderr)
  r=self.run_worker(env={'TEST_NO_LATEST':'1'});self.assertNotEqual(r.returncode,0)
  self.assertIn('没有可访问的正式 Release',r.stderr)
  for bad in ['v1.2.3-','v1.2.3-rc 1','1.2.3-rc.1']:
   r=self.run_worker('--version',bad);self.assertNotEqual(r.returncode,0,bad)
  self.clean_tmp()
 def test_latest_install_never_calls_the_github_api(self):
  # Anonymous API requests are rate limited per IP; /releases/latest is enough.
  r=self.run_worker(env={'TEST_API_LIMIT':'1'});self.assertEqual(r.returncode,0,r.stderr)
  self.assertFalse(any('api.github.com' in str(a) for n,a in self.calls() if n=='curl'))
 def test_explicit_version_survives_an_exhausted_api_limit(self):
  r=self.run_worker('--version','v1.2.3',env={'TEST_API_LIMIT':'1'});self.assertEqual(r.returncode,0,r.stderr)
  self.assertIn('GitHub API 暂不可用',r.stderr)
  # Without the API the SHA-256 and the asset download still guard the install.
  shutil.rmtree(self.env['WORKER_PLANE_HOME'])
  r=self.run_worker('--version','v1.2.3',env={'TEST_API_LIMIT':'1','TEST_BAD_HASH':'1'});self.assertNotEqual(r.returncode,0)
  self.assertFalse((Path(self.env['WORKER_PLANE_HOME'])/'bin/worker').exists())
  self.clean_tmp()
 def test_system_trust_has_no_insecure_or_ca_parameter(self):
  r=subprocess.run([BASH,str(SCRIPT),'worker','--server','https://plane.example.com'],env=self.env,capture_output=True,text=True)
  self.assertEqual(r.returncode,0,r.stderr)
  health=[a for n,a in self.calls() if n=='curl' and any(x.endswith('/health') for x in a)]
  self.assertTrue(health);self.assertTrue(all('--insecure' not in a and '--cacert' not in a for a in health))
  self.assertFalse((Path(self.env['WORKER_PLANE_HOME'])/'ca.pem').exists())
 def test_fingerprint_bootstrap_and_fail_closed(self):
  import shutil
  subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(self.root/'key.pem'),'-out',str(self.root/'bootstrap.pem'),'-days','1','-subj','/CN=test-ca'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  der=subprocess.check_output(['openssl','x509','-in',str(self.root/'bootstrap.pem'),'-outform','DER'])
  pin=hashlib.sha256(der).hexdigest()
  args=[BASH,str(SCRIPT),'worker','--server','https://plane.internal:8443','--ca-fingerprint',pin]
  for env in [{'TEST_TLS_FAIL':'1'},{'TEST_BAD_HASH':'1'}]:
   r=subprocess.run(args,env={**self.env,**env},capture_output=True,text=True)
   self.assertNotEqual(r.returncode,0,r.stderr)
   self.assertFalse((Path(self.env['WORKER_PLANE_HOME'])/'bin/worker').exists())
  r=subprocess.run(args[:-1]+['0'*64],env=self.env,capture_output=True,text=True)
  self.assertNotEqual(r.returncode,0);self.assertIn('指纹不匹配',r.stderr)
  r=subprocess.run(args,env=self.env,capture_output=True,text=True)
  self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual((Path(self.env['WORKER_PLANE_HOME'])/'ca.pem').read_bytes(),(self.root/'bootstrap.pem').read_bytes())
  bootstrap_calls=[a for n,a in self.calls() if n=='curl' and any('/.well-known/willcord/ca.pem' in x for x in a)]
  self.assertTrue(all('--insecure' in a and '--location' not in a for a in bootstrap_calls))
  self.assertFalse(any('--insecure' in a for n,a in self.calls() if n=='curl' and not any('/.well-known/willcord/ca.pem' in x for x in a)))
  shutil.rmtree(self.env['WORKER_PLANE_HOME'])
  (self.root/'bootstrap.pem').write_bytes(b'x'*65537)
  r=subprocess.run(args,env=self.env,capture_output=True,text=True)
  self.assertNotEqual(r.returncode,0);self.assertFalse((Path(self.env['WORKER_PLANE_HOME'])/'bin/worker').exists())
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
  self.assertIn('MODEL_API_KEY="key$$with#special"',(deploy/'main.env').read_text())
  self.assertIn('WORKER_PLANE_PORT="8443"',(deploy/'.env').read_text())
  self.assertIn('COMPOSE_PROJECT_NAME=',(deploy/'.env').read_text())
  self.assertEqual((deploy/'ca.pem').stat().st_mode&0o777,0o644)
  self.assertNotIn('long\'password',out)
  self.clean_tmp()
  # Existing config is never replaced.
  before=(deploy/'main.env').read_bytes()
  code,out=self.main_tty();self.assertNotEqual(code,0,out)
  self.assertEqual((deploy/'main.env').read_bytes(),before)
 def test_main_wizard_runs_on_macos_docker_desktop(self):
  code,out=self.main_tty(env={'TEST_OS':'Darwin','TEST_ARCH':'arm64'});self.assertEqual(code,0,out)
  self.assertIn('Docker Desktop',out)
  self.assertTrue((self.root/'deployment/main.env').exists())
 def test_model_key_is_checked_before_anything_is_written(self):
  code,out=self.main_tty(env={'TEST_KEY_STATUS':'401'});self.assertNotEqual(code,0,out)
  self.assertIn('拒绝了这个 API key',out)
  self.assertEqual(list((self.root/'deployment').iterdir()),[],'a rejected key leaves no config behind')
  self.assertFalse(any(n=='docker' and a[:2]==['compose','up'] for n,a in self.calls()))
  # The key travels over stdin, never through argv.
  self.assertFalse(any('key$with#special' in str(a) for _,a in self.calls()))
  self.clean_tmp()
  # A fixed key can reuse the same directory.
  code,out=self.main_tty();self.assertEqual(code,0,out);self.assertIn('API key 检查通过',out)
 def test_unconfirmed_model_key_only_warns(self):
  for status in ['403','500','000']:
   with self.subTest(status=status):
    shutil.rmtree(self.root/'deployment',ignore_errors=True)
    code,out=self.main_tty(env={'TEST_KEY_STATUS':status});self.assertEqual(code,0,out)
    self.assertIn('无法确认模型 API key',out)
 def test_main_start_failure_keeps_config_and_password_for_recovery(self):
  code,out=self.main_tty(env={'TEST_START_FAIL':'1'});self.assertNotEqual(code,0,out)
  self.assertIn('docker compose logs',out)
  self.assertIn('INITIAL_ADMIN_PASSWORD=',(self.root/'deployment/main.env').read_text())
  self.clean_tmp()

if __name__=='__main__':unittest.main()
