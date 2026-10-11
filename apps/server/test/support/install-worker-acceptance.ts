// Real macOS LaunchAgent and authorized Linux systemd acceptance against an
// isolated scripted main node. Before a public release, only release downloads
// are replaced by checksummed locally built assets; HTTPS/WSS remain real.
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { startScenario } from "./main-node.js";
import { repoRoot } from "./worker-harness.js";
const exec = promisify(execFile);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const remote = process.env.WILLCORD_TEST_SSH_TARGET;
const mode = process.env.WILLCORD_ACCEPTANCE_MODE ?? "macos";
if (mode === "linux" && remote !== "colo") throw new Error("Linux acceptance requires explicitly authorized colo target");
if (mode === "macos" && process.platform !== "darwin") throw new Error("macOS required");
const s = await startScenario({ scripts: { smoke: [{ tool: "bash", id: "install-smoke", arguments: { command: "pwd && ls -la && printf 'install-ok\\n' > acceptance.txt && cat acceptance.txt" } }, { text: "Installation acceptance completed." }] } });
const version = "v0.2.0";
const assetName = `willcord-${version}-${mode === "linux" ? "linux-x86_64" : `darwin-${process.arch === "arm64" ? "arm64" : "x86_64"}`}`;
const binary = join(repoRoot, mode === "linux" ? "worker/target/x86_64-unknown-linux-gnu/release/willcord" : "worker/target/release/willcord");
const nonce = randomBytes(6).toString("hex");
const remoteDir = `/tmp/willcord-install-acceptance-${nonce}`;
const dir = mode === "linux" ? remoteDir : s.dir;
const data = join(dir, mode === "linux" ? "system" : "user's data");
const shim = join(dir, "shim"), assets = join(dir, "assets");
const worker = join(data, "bin/willcord");
let tunnel: ChildProcess | undefined, installed = false, cleanupFailed = false;
const ssh = (cmd: string) => exec("ssh", [remote!, cmd], { timeout: 120000, maxBuffer: 1024 * 1024 });
const env = { ...process.env, WILLCORD_HOME: data, WILLCORD_LAUNCH_AGENT_DIR: join(dir, "LaunchAgents"), PATH: `${shim}:${process.env.PATH}` };
delete env.SSL_CERT_FILE; delete env.SSL_CERT_DIR; delete env.WORKER_TOKEN;
const remoteEnv = `WILLCORD_SYSTEM_ROOT=${quote(data)}`;
const localCli = (...args: string[]) => exec(worker, args, { env, timeout: 90000 });
const cli = (...args: string[]) => mode === "linux" ? ssh(`sudo -n env ${remoteEnv} ${quote(worker)} ${args.map(quote).join(" ")} --system`) : localCli(...args);
try {
  mkdirSync(join(s.dir,"assets"));mkdirSync(join(s.dir,"shim"));
  const sha = createHash("sha256").update(readFileSync(binary)).digest("hex");
  copyFileSync(binary,join(s.dir,"assets",assetName));
  writeFileSync(join(s.dir,"assets",assetName+".sha256"),`${sha}  ${assetName}\n`);
  const curl = `#!/usr/bin/env python3\nimport json,os,pathlib,sys\na=sys.argv[1:]\nu=next((x for x in a if x.startswith('https://')), '')\nif '/releases/tags/' in u:\n pathlib.Path(a[a.index('-o')+1]).write_text(json.dumps({'draft':False,'prerelease':False}))\nelif '/releases/download/' in u:\n pathlib.Path(a[a.index('-o')+1]).write_bytes((pathlib.Path(${JSON.stringify(assets)})/u.rsplit('/',1)[-1]).read_bytes())\nelse: os.execv('/usr/bin/curl',['curl',*a])\n`;
  writeFileSync(join(s.dir,"shim/curl"),curl,{mode:0o700});
  let server = s.proxy.url.replace("wss:","https:").replace("/ws/worker","");
  if (mode === "linux") {
    await ssh(`mkdir -m 700 ${quote(dir)} && mkdir ${quote(shim)} ${quote(assets)}`);
    await exec("scp",[binary,`${remote}:${assets}/${assetName}`]);
    await exec("scp",[join(s.dir,"assets",assetName+".sha256"),`${remote}:${assets}/`]);
    await exec("scp",[join(s.dir,"shim/curl"),`${remote}:${shim}/curl`]);
    await exec("scp",[join(s.dir,"ca.pem"),`${remote}:${dir}/ca.pem`]);
    await exec("scp",[join(repoRoot,"deploy/install.sh"),`${remote}:${dir}/install.sh`]);
    await ssh(`chmod 700 ${quote(shim+"/curl")} && sudo -n true`);
    const reversePort = 42000 + parseInt(nonce.slice(0,4),16)%15000;
    const collision = await ssh(`ss -H -ltn sport = :${reversePort}`);assert.equal(collision.stdout.trim(),"");
    tunnel = spawn("ssh",["-N","-T","-o","ControlMaster=no","-o","ControlPath=none","-o","ExitOnForwardFailure=yes","-R",`127.0.0.1:${reversePort}:127.0.0.1:${new URL(s.proxy.url).port}`,remote!],{stdio:["ignore","ignore","pipe"]});
    let listening = false, tunnelErrors = "";
    tunnel.stderr!.on("data", chunk => tunnelErrors += chunk.toString());
    for (let attempt = 0; attempt < 40; attempt++) {
      assert.equal(tunnel.exitCode,null,tunnelErrors);
      const ports = await ssh(`ss -H -ltn sport = :${reversePort}`);
      if (ports.stdout.trim()) { listening = true; break; }
      await new Promise(r=>setTimeout(r,250));
    }
    assert.ok(listening, `reverse tunnel never became ready: ${tunnelErrors}`);
    server=`https://localhost:${reversePort}`;
  }
  installed = true; // Even a join failure must uninstall a service already created.
  const runInstall = () => mode === "linux" ? ssh(`env PATH=${quote(shim+":/usr/local/bin:/usr/bin:/bin")} ${remoteEnv} bash ${quote(dir+"/install.sh")} worker --version ${version} --server ${quote(server)} --ca ${quote(dir+"/ca.pem")} --system --user bossx`) : exec("bash",[join(repoRoot,"deploy/install.sh"),"worker","--version",version,"--server",server,"--ca",join(s.dir,"ca.pem")],{env,timeout:90000});
  const joined = await runInstall();
  const id = s.one("SELECT worker_id FROM enrollments ORDER BY created_at DESC LIMIT 1").worker_id;
  assert.ok(joined.stdout.includes(`Fingerprint (SHA-256 of public key): ${id}`));
  assert.equal((await s.api("POST",`/api/enrollments/${id}/approve`,{})).statusCode,200);
  await s.until(()=>s.one("SELECT online,reconciled,blocked FROM workers WHERE worker_id=?",id)?.reconciled===1,60000);
  const status=JSON.parse((await cli("status","--json")).stdout);
  assert.equal(status.online,1);assert.equal(status.reconciled,1);assert.equal(status.blocked,0);assert.equal(status.service_running,true);
  if (mode === "linux") assert.equal(status.service_scope,"system");
  const session=(await s.api("POST","/api/sessions",{worker_id:id,workspace_id:"default"})).json().session_id;
  const job=await s.submit(session,"smoke");await s.until(()=>s.state(job)==="succeeded",60000);
  const marker = mode === "linux" ? (await ssh(`cat ${quote(data+"/data/workspaces/default/acceptance.txt")}`)).stdout.trim() : readFileSync(join(data,"workspaces/default/acceptance.txt"),"utf8").trim();assert.equal(marker,"install-ok");
  const ledger=s.one("SELECT ledger_id FROM workers WHERE worker_id=?",id).ledger_id;
  await runInstall();
  await s.until(()=>s.one("SELECT online,reconciled FROM workers WHERE worker_id=?",id)?.reconciled===1,60000);
  assert.equal(s.one("SELECT ledger_id FROM workers WHERE worker_id=?",id).ledger_id,ledger);
  console.log(JSON.stringify({platform:mode,download_source:"checksummed-local-release-fixture",worker_sha256:sha,authorized:true,online:1,reconciled:1,blocked:0,task_state:s.state(job),service_scope:status.service_scope,ledger_preserved:true},null,2));
} finally {
  if (installed) {
    try {
      const binaryExists = mode === "linux" ? (await ssh(`test -x ${quote(worker)} && echo yes || echo no`)).stdout.trim() === "yes" : existsSync(worker);
      if (binaryExists) await cli("uninstall","--delete-data");
    }
    catch (e) { cleanupFailed = true; console.error("Cleanup failed; preserve acceptance directory",dir,String(e)); }
  }
  if (mode === "linux" && !cleanupFailed) await ssh(`rm -rf ${quote(dir)}`);
  if (tunnel && tunnel.exitCode===null) {tunnel.kill("SIGTERM");await new Promise<void>(r=>tunnel!.once("exit",()=>r()));}
  if (cleanupFailed) { await s.stopMain(); await s.proxy.close(); } else await s.close();
}
