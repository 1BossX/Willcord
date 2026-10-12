#!/usr/bin/env python3
"""Exercise the public installer with offline release, service and Docker fixtures."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('install.sh').resolve()
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
 if args==['-un']: print('builder');sys.exit()
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
 if url.endswith('/latest'): print('https://github.com/BossOptional/Willcord/releases' if os.environ.get('TEST_NO_LATEST')=='1' else 'https://github.com/BossOptional/Willcord/releases/tag/v1.2.3',end='');sys.exit()
 dest=p(args[args.index('-o')+1]) if '-o' in args else None
 if '/releases/tags/' in url and os.environ.get('TEST_API_LIMIT')=='1': sys.exit(22)
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
elif name in ['sleep','systemctl','launchctl']:pass
else:
 if args[:2]==['main','init']:
  if os.environ.get('TEST_MAIN_FAIL')=='1':sys.exit(3)
 elif args[:1]==['self-install']:
  target=p(os.environ['WILLCORD_SYSTEM_ROOT'])/'bin/willcord' if '--system' in args else p(os.environ['WILLCORD_HOME'])/'bin/willcord'
  target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(sys.argv[0],target);target.chmod(0o700)
  print('已安装命令：'+str(target))
 elif args[:2]==['worker','join']:
  # The real binary installs the service, saves the CA and files the request.
  if os.environ.get('TEST_JOIN_FAIL')=='1':sys.exit(3)
  target=p(os.environ['WILLCORD_SYSTEM_ROOT'])/'bin/willcord' if '--system' in args else p(os.environ['WILLCORD_HOME'])/'bin/willcord'
  target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(sys.argv[0],target);target.chmod(0o700)
  if '--ca' in args:(target.parent.parent/'ca.pem').write_bytes(p(args[args.index('--ca')+1]).read_bytes())
  print('Node: fixture\nAuthorization: pending')
'''

class InstallerTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='wp-install-test-')
  self.root=Path(self.temp.name)
  self.bin=self.root/'bin';self.bin.mkdir()
  self.assets=self.root/'assets';self.assets.mkdir()
  stub=f'#!{sys.executable}\n'+STUB
  for name in ['uname','curl','id','sudo','sleep','systemctl','launchctl']:
   path=self.bin/name;path.write_text(stub);path.chmod(0o700)
  for os_name,arch in [('linux','x86_64'),('linux','aarch64'),('darwin','x86_64'),('darwin','arm64')]:
   self.asset(f'willcord-v1.2.3-{os_name}-{arch}',stub.encode())
  self.asset('willcord-v1.2.3-rc.1-linux-x86_64',stub.encode())
  self.ca=self.root/"CA directory/o'ne.pem";self.ca.parent.mkdir();self.ca.write_text('CA')
  self.env={**os.environ,'LANG':'en_US.UTF-8','LC_ALL':'en_US.UTF-8','PATH':f'{self.bin}:{os.environ["PATH"]}','TEST_ROOT':str(self.root),'WILLCORD_HOME':str(self.root/"user's data"),'WILLCORD_SYSTEM_ROOT':str(self.root/'system data'),'TMPDIR':str(self.root)}
  self.env.pop('SSL_CERT_FILE',None)
 def tearDown(self):self.temp.cleanup()
 def asset(self,name,data):
  (self.assets/name).write_bytes(data)
  (self.assets/(name+'.sha256')).write_text(hashlib.sha256(data).hexdigest()+'  '+name+'\n')
 def calls(self):return [json.loads(x) for x in (self.root/'calls').read_text().splitlines()]
 def run_worker(self,*extra,env=None):
  return subprocess.run([BASH,str(SCRIPT),'worker','--server','https://plane.internal:8443','--ca',str(self.ca),*extra],env={**self.env,**(env or {})},capture_output=True,text=True)
 def clean_tmp(self):self.assertFalse(list(self.root.glob('willcord-install.*')))
 def test_four_platforms_and_literal_paths(self):
  for os_name,arch,asset_os,asset_arch in [('Linux','x86_64','linux','x86_64'),('Linux','arm64','linux','aarch64'),('Darwin','x86_64','darwin','x86_64'),('Darwin','arm64','darwin','arm64')]:
   with self.subTest(os=os_name,arch=arch):
    r=self.run_worker('--version','v1.2.3',env={'TEST_OS':os_name,'TEST_ARCH':arch})
    self.assertEqual(r.returncode,0,r.stderr)
    self.assertTrue(any(asset_os+'-'+asset_arch in str(a) for n,a in self.calls() if n=='curl'))
    self.assertEqual(self.handed_over()[-1],['worker','join','https://plane.internal:8443','--ca',str(self.ca)])
    (self.root/'calls').unlink()
    self.clean_tmp()
 def test_latest_and_system_account(self):
  r=self.run_worker('--system','--user','ops');self.assertEqual(r.returncode,0,r.stderr)
  self.assertIn('安装版本：v1.2.3',r.stdout)
  self.assertTrue((Path(self.env['WILLCORD_SYSTEM_ROOT'])/'bin/willcord').exists())
  self.assertTrue(any('--system' in a and 'join' in a for _,a in self.calls()))
 def test_no_release_hash_download_and_account_fail_before_install(self):
  for env,args in [({'TEST_NO_RELEASE':'1'},[]),({'TEST_PRERELEASE':'1'},['--version','v1.2.3']),({'TEST_BAD_HASH':'1'},[]),({'TEST_DOWNLOAD_FAIL':'1'},[]),({},['--system','--user','root']),({},['--system','--user','missing']),({'TEST_ARCH':'riscv64'},[])]:
   with self.subTest(env=env,args=args):
    r=self.run_worker(*args,env=env);self.assertNotEqual(r.returncode,0)
    self.assertFalse((Path(self.env['WILLCORD_HOME'])/'bin/willcord').exists())
    self.assertFalse((Path(self.env['WILLCORD_SYSTEM_ROOT'])/'bin/willcord').exists())
    self.clean_tmp()
 def test_prerelease_only_when_named(self):
  r=self.run_worker('--version','v1.2.3-rc.1',env={'TEST_PRERELEASE':'1'});self.assertEqual(r.returncode,0,r.stderr)
  self.assertIn('安装预发布版本：v1.2.3-rc.1',r.stdout)
  self.assertTrue(any('willcord-v1.2.3-rc.1-linux-x86_64' in str(a) for n,a in self.calls() if n=='curl'))
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
  shutil.rmtree(self.env['WILLCORD_HOME'])
  r=self.run_worker('--version','v1.2.3',env={'TEST_API_LIMIT':'1','TEST_BAD_HASH':'1'});self.assertNotEqual(r.returncode,0)
  self.assertFalse((Path(self.env['WILLCORD_HOME'])/'bin/willcord').exists())
  self.clean_tmp()
 def test_without_a_ca_the_binary_is_told_to_trust_the_system_store(self):
  r=subprocess.run([BASH,str(SCRIPT),'worker','--server','https://plane.example.com'],env=self.env,capture_output=True,text=True)
  self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(self.handed_over(),[['worker','join','https://plane.example.com']])
  # The script itself no longer talks to the main node: the binary checks it.
  self.assertFalse(any(x.endswith('/health') or '/.well-known/' in x for n,a in self.calls() if n=='curl' for x in a))
  self.assertFalse((Path(self.env['WILLCORD_HOME'])/'ca.pem').exists())
 def test_a_fingerprint_is_passed_to_the_binary_which_pins_the_certificate(self):
  # Fetching the root certificate and checking it against the pin is the
  # binary's job (deploy/test-worker-join.py); the script validates the shape.
  pin='ab'*32
  r=subprocess.run([BASH,str(SCRIPT),'worker','--server','https://plane.internal:8443','--ca-fingerprint',pin],env=self.env,capture_output=True,text=True)
  self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(self.handed_over(),[['worker','join','https://plane.internal:8443','--ca-fingerprint',pin]])
  self.assertFalse(any('--insecure' in a for n,a in self.calls() if n=='curl'))
  (self.root/'calls').unlink()
  for bad in ['0'*63,'z'*64,'']:
   r=subprocess.run([BASH,str(SCRIPT),'worker','--server','https://plane.internal:8443','--ca-fingerprint',bad],env=self.env,capture_output=True,text=True)
   self.assertNotEqual(r.returncode,0,bad)
  r=self.run_worker('--ca-fingerprint',pin);self.assertNotEqual(r.returncode,0);self.assertIn('不能同时使用',r.stderr)
  self.assertEqual(self.handed_over(),[]);self.clean_tmp()
 def test_a_join_link_carries_the_address_and_the_pin_in_one_argument(self):
  pin='ab'*32;link=f'https://plane.internal:8443#sha256={pin}'
  def worker(*args):return subprocess.run([BASH,str(SCRIPT),'worker',*args],env=self.env,capture_output=True,text=True)
  r=worker(link);self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(self.handed_over(),[['worker','join','https://plane.internal:8443','--ca-fingerprint',pin]])
  (self.root/'calls').unlink()
  # The older --server spelling takes the same link.
  r=worker('--server',link);self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(self.handed_over(),[['worker','join','https://plane.internal:8443','--ca-fingerprint',pin]])
  (self.root/'calls').unlink()
  for args in [[link,'--ca-fingerprint',pin],[link,'--ca',str(self.ca)],[f'https://plane.internal:8443#sha256={pin[:-1]}'],['https://plane.internal:8443#'],['https://plane.internal:8443#sha1='+pin],[link,'https://other.internal'],[]]:
   with self.subTest(args=args):
    r=worker(*args);self.assertNotEqual(r.returncode,0)
  self.assertEqual(self.handed_over(),[]);self.clean_tmp()
 def test_only_worker_takes_a_bare_link(self):
  for args in [['https://plane.internal:8443'],['main','https://plane.internal:8443']]:
   r=subprocess.run([BASH,str(SCRIPT),*args],env=self.env,capture_output=True,text=True);self.assertNotEqual(r.returncode,0,args)
  self.assertFalse((self.root/'calls').exists())
 def test_a_system_service_runs_as_the_installing_account_unless_told_otherwise(self):
  r=subprocess.run([BASH,str(SCRIPT),'worker','https://plane.example.com','--system'],env=self.env,capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(self.handed_over(),[['worker','join','https://plane.example.com','--system','--user','builder']])
 def test_reinstall_preserves_identity_and_ledger(self):
  data=self.root/"user's data";data.mkdir()
  for name in ['identity.pk8','ledger.sqlite']:(data/name).write_text('keep')
  for _ in range(2):
   r=self.run_worker();self.assertEqual(r.returncode,0,r.stderr)
  for name in ['identity.pk8','ledger.sqlite']:self.assertEqual((data/name).read_text(),'keep')
 def run_main(self,*extra,env=None):
  return subprocess.run([BASH,str(SCRIPT),'main','--dir',str(self.root/'deployment'),*extra],env={**self.env,**(env or {})},capture_output=True,text=True)
 def handed_over(self):return [a for n,a in self.calls() if n.startswith('willcord-')]
 def test_main_hands_over_to_the_verified_binary(self):
  # The wizard itself is `willcord main init` (test-main-node.py); the script
  # only fetches the release binary, checks its SHA-256 and passes the options on.
  deployment=str(self.root/'deployment')
  r=self.run_main('--server','https://plane.internal:8443','--version','v1.2.3');self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(self.handed_over(),[['main','init','--dir',deployment,'--image-version','v1.2.3','--server','https://plane.internal:8443']])
  self.assertTrue(any('willcord-v1.2.3-linux-x86_64' in str(a) for n,a in self.calls() if n=='curl'))
  self.clean_tmp()
  # No --server: the wizard asks. The latest release is resolved first.
  (self.root/'calls').unlink()
  r=self.run_main();self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(self.handed_over(),[['main','init','--dir',deployment,'--image-version','v1.2.3']])
 def test_main_picks_the_platform_binary_and_keeps_the_wizard_exit_status(self):
  r=self.run_main(env={'TEST_OS':'Darwin','TEST_ARCH':'arm64'});self.assertEqual(r.returncode,0,r.stderr)
  self.assertTrue(any('willcord-v1.2.3-darwin-arm64' in str(a) for n,a in self.calls() if n=='curl'))
  r=self.run_main(env={'TEST_MAIN_FAIL':'1'});self.assertEqual(r.returncode,3)
  self.clean_tmp()
 def test_main_runs_nothing_when_the_download_cannot_be_trusted(self):
  for env in [{'TEST_BAD_HASH':'1'},{'TEST_DOWNLOAD_FAIL':'1'},{'TEST_NO_RELEASE':'1'}]:
   with self.subTest(env=env):
    r=self.run_main(env=env);self.assertNotEqual(r.returncode,0)
    self.assertEqual(self.handed_over(),[]);self.clean_tmp()
 def test_main_takes_no_worker_options(self):
  for extra in [['--system'],['--user','ops'],['--ca','/x.pem'],['--ca-fingerprint','0'*64]]:
   with self.subTest(extra=extra):
    r=self.run_main(*extra);self.assertNotEqual(r.returncode,0);self.assertIn('main 不接受',r.stderr)
    self.assertEqual(self.handed_over(),[])
 def test_the_join_exit_status_is_kept_and_a_system_join_is_one_sudo(self):
  r=self.run_worker(env={'TEST_JOIN_FAIL':'1'});self.assertEqual(r.returncode,3)
  (self.root/'calls').unlink()
  r=self.run_worker('--system','--user','ops');self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(len([1 for n,a in self.calls() if n=='sudo']),1)
  self.assertEqual(self.handed_over(),[['worker','join','https://plane.internal:8443','--ca',str(self.ca),'--system','--user','ops']])
 def run_install(self,*extra,env=None):
  return subprocess.run([BASH,str(SCRIPT),*extra],env={**self.env,**(env or {})},capture_output=True,text=True)
 def test_without_a_role_only_the_command_is_installed(self):
  r=self.run_install();self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(self.handed_over(),[['self-install']])
  self.assertTrue((Path(self.env['WILLCORD_HOME'])/'bin/willcord').exists())
  self.assertIn('willcord main init',r.stdout);self.assertIn('willcord worker join',r.stdout)
  self.assertFalse(any(a[:1] in (['main'],['worker']) for a in self.handed_over()))
  self.clean_tmp()
 def test_a_pinned_version_and_the_platform_binary_are_used_when_only_installing(self):
  r=self.run_install('--version','v1.2.3',env={'TEST_OS':'Darwin','TEST_ARCH':'arm64'});self.assertEqual(r.returncode,0,r.stderr)
  self.assertTrue(any('willcord-v1.2.3-darwin-arm64' in str(a) for n,a in self.calls() if n=='curl'))
 def test_a_system_install_of_the_command_is_one_sudo(self):
  r=self.run_install('--system');self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(len([1 for n,a in self.calls() if n=='sudo']),1)
  self.assertEqual(self.handed_over(),[['self-install','--system']])
  self.assertTrue((Path(self.env['WILLCORD_SYSTEM_ROOT'])/'bin/willcord').exists())
 def test_installing_the_command_takes_no_start_options_and_runs_nothing_untrusted(self):
  for extra in [['--server','https://plane.internal:8443'],['--ca','/x.pem'],['--ca-fingerprint','0'*64],['--user','ops'],['--dir','/x']]:
   with self.subTest(extra=extra):
    r=self.run_install(*extra);self.assertNotEqual(r.returncode,0);self.assertEqual(self.handed_over(),[])
  for env in [{'TEST_BAD_HASH':'1'},{'TEST_DOWNLOAD_FAIL':'1'},{'TEST_NO_RELEASE':'1'}]:
   with self.subTest(env=env):
    r=self.run_install(env=env);self.assertNotEqual(r.returncode,0);self.assertEqual(self.handed_over(),[])
    self.assertFalse((Path(self.env['WILLCORD_HOME'])/'bin/willcord').exists());self.clean_tmp()
 def test_an_unknown_first_word_is_a_usage_error(self):
  r=self.run_install('both');self.assertNotEqual(r.returncode,0);self.assertIn('用法',r.stderr)
if __name__=='__main__':unittest.main()
