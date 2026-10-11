// Manual Linux acceptance: build the release worker, then run this from the
// repository root with SSH access to the isolated target (defaults to `colo`).
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { startScenario } from "./main-node.js";
import { repoRoot, waitFor } from "./worker-harness.js";

const exec = promisify(execFile);
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const artifact = join(repoRoot, "worker/target/x86_64-unknown-linux-gnu/release/willcord");
const target = process.env.WILLCORD_TEST_SSH_TARGET;
if (!target) throw new Error("set WILLCORD_TEST_SSH_TARGET to an explicitly authorized SSH alias");

async function ssh(command: string) {
  const result = await exec("ssh", [target, command], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

async function run() {
  const randomId = randomBytes(6).toString("hex");
  const workspaceName = `colo-linux-${randomId}`;
  const scenario = await startScenario({
    scripts: {
      "colo-smoke": [
        { tool: "bash", id: "colo-smoke-1", arguments: { command: "uname -srm && echo colo-worker-ok > enrollment.txt && cat enrollment.txt" } },
        { text: "Linux worker enrollment smoke test completed." },
      ],
    },
  });
  const localCa = join(scenario.dir, "ca.pem");
  const localPort = Number(new URL(scenario.proxy.url).port);
  const reversePort = 41000 + (Number.parseInt(randomId.slice(0, 6), 16) % 18000);
  const remoteHome = await ssh("getent passwd \"$(id -un)\" | cut -d: -f6");
  const workerData = join(remoteHome, ".local/share", `willcord-${workspaceName}`);
  const staging = `/tmp/willcord-${workspaceName}`;
  const sshTarget = target;
  let tunnel: ChildProcess | undefined;
  let tunnelError = "";
  let workerDataCreated = false;
  let stagingCreated = false;
  let outcome: unknown;
  try {
    const collision = await ssh(`ss -H -ltn sport = :${reversePort}`);
    if (collision) throw new Error(`colo port ${reversePort} is already in use`);
    await ssh(`python3 -c ${shellQuote("import os,sys; os.makedirs(sys.argv[1],exist_ok=True)")} ${shellQuote(join(remoteHome, ".local/share"))}`);
    await ssh(`mkdir -m 700 ${shellQuote(workerData)}`);
    workerDataCreated = true;
    await ssh(`mkdir -m 700 ${shellQuote(staging)}`);
    stagingCreated = true;

    tunnel = spawn("ssh", [
      "-N", "-T", "-o", "ControlMaster=no", "-o", "ControlPath=none",
      "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
      "-R", `127.0.0.1:${reversePort}:127.0.0.1:${localPort}`, sshTarget,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    tunnel.stderr!.on("data", (data) => { tunnelError += data.toString(); });
    await delay(750);
    if (tunnel.exitCode !== null || tunnel.signalCode !== null)
      throw new Error(`SSH reverse tunnel failed: ${tunnelError.trim()}`);

    const remoteBinary = `${staging}/worker`;
    const remoteCa = `${workerData}/ca.pem`;
    await Promise.all([
      exec("scp", ["-q", "-o", "ControlMaster=no", "-o", "ControlPath=none", artifact, `${sshTarget}:${remoteBinary}`]),
      exec("scp", ["-q", "-o", "ControlMaster=no", "-o", "ControlPath=none", localCa, `${sshTarget}:${staging}/ca.pem`]),
    ]);
    await ssh(`install -m 700 ${shellQuote(remoteBinary)} ${shellQuote(remoteBinary)}.installed && install -m 600 ${shellQuote(`${staging}/ca.pem`)} ${shellQuote(remoteCa)}`);
    const localHash = createHash("sha256").update(readFileSync(artifact)).digest("hex");
    const remoteHash = (await ssh(`sha256sum ${shellQuote(`${remoteBinary}.installed`)}`)).split(/\s+/)[0];
    if (localHash !== remoteHash) throw new Error("colo worker binary SHA-256 does not match the local release artifact");

    await ssh(`env WILLCORD_HOME=${shellQuote(workerData)} SSL_CERT_FILE=${shellQuote(remoteCa)} ${shellQuote(`${remoteBinary}.installed`)} worker install`);
    await ssh(`rm -f ${shellQuote(remoteBinary)} ${shellQuote(`${remoteBinary}.installed`)} ${shellQuote(`${staging}/ca.pem`)}`);
    const remoteWorker = join(workerData, "bin/willcord");
    const publicUrl = `https://localhost:${reversePort}`;
    const remoteEnvironment = `WILLCORD_HOME=${shellQuote(workerData)} SSL_CERT_FILE=${shellQuote(remoteCa)}`;
    const joined = await ssh(`env ${remoteEnvironment} ${shellQuote(remoteWorker)} worker join ${shellQuote(publicUrl)}`);
    if (!/Authorization:\s*"?pending"?/.test(joined)) throw new Error(`unexpected enrollment response: ${joined}`);

    const pending = scenario.one("SELECT worker_id FROM enrollments WHERE name LIKE 'colo%' ORDER BY created_at DESC LIMIT 1") as { worker_id?: string } | undefined;
    const workerId = pending?.worker_id ?? (scenario.one("SELECT worker_id FROM enrollments ORDER BY created_at DESC LIMIT 1") as { worker_id: string }).worker_id;
    const approval = await scenario.api("POST", `/api/enrollments/${workerId}/approve`, {});
    if (approval.statusCode !== 200) throw new Error(`admin approval failed (${approval.statusCode}): ${approval.body}`);
    await scenario.until(() => {
      const row = scenario.one("SELECT online,reconciled,blocked,ledger_id FROM workers WHERE worker_id=?", workerId);
      return row?.online === 1 && row.reconciled === 1 && row.blocked === 0 && Boolean(row.ledger_id);
    }, 60_000);

    const status = JSON.parse(await ssh(`env ${remoteEnvironment} ${shellQuote(remoteWorker)} worker status --json`));
    if (status.online !== 1 || status.reconciled !== 1 || status.blocked !== 0 || status.service_running !== true)
      throw new Error(`colo worker is not ready: ${JSON.stringify(status)}`);
    const ledgerBefore = (scenario.one("SELECT ledger_id FROM workers WHERE worker_id=?", workerId) as { ledger_id: string }).ledger_id;

    const sessionResponse = await scenario.api("POST", "/api/sessions", { worker_id: workerId, workspace_id: "default" });
    if (sessionResponse.statusCode !== 201) throw new Error(`could not create default-workspace session: ${sessionResponse.body}`);
    const jobId = await scenario.submit(sessionResponse.json().session_id, "colo-smoke");
    await scenario.until(() => scenario.state(jobId) === "succeeded", 60_000);
    const marker = await ssh(`cat ${shellQuote(`${workerData}/workspaces/default/enrollment.txt`)}`);
    if (marker !== "colo-worker-ok") throw new Error(`unexpected marker from colo workspace: ${marker}`);

    await ssh(`env ${remoteEnvironment} ${shellQuote(remoteWorker)} worker install`);
    await scenario.until(() => scenario.one("SELECT online,reconciled,ledger_id FROM workers WHERE worker_id=?", workerId)?.reconciled === 1, 60_000);
    const ledgerAfter = (scenario.one("SELECT ledger_id FROM workers WHERE worker_id=?", workerId) as { ledger_id: string }).ledger_id;
    if (ledgerBefore !== ledgerAfter) throw new Error("ledger identity changed during service upgrade");
    const finalStatus = JSON.parse(await ssh(`env ${remoteEnvironment} ${shellQuote(remoteWorker)} worker status --json`));
    outcome = { worker_id: workerId, online: finalStatus.online, reconciled: finalStatus.reconciled, blocked: finalStatus.blocked, service_name: finalStatus.service_name, ledger_preserved: true, task_id: jobId, task_state: scenario.state(jobId), workspace_marker: marker, worker_sha256: localHash };
  } catch (error) {
    outcome = error;
  } finally {
    if (workerDataCreated) {
      try {
        const remoteWorker = join(workerData, "bin/willcord");
        const isInstalled = await ssh(`test -x ${shellQuote(remoteWorker)} && echo yes || echo no`);
        if (isInstalled === "yes")
          await ssh(`env WILLCORD_HOME=${shellQuote(workerData)} ${shellQuote(remoteWorker)} worker uninstall --delete-data`);
        else
          await ssh(`rm -f ${shellQuote(join(workerData, "ca.pem"))} && rmdir ${shellQuote(workerData)}`);
      } catch (error) {
        console.error(`worker cleanup needs attention; preserved isolated data path ${workerData}: ${String(error)}`);
      }
    }
    try { if (stagingCreated) await ssh(`rm -rf ${shellQuote(staging)}`); }
    catch (error) { console.error(`staging cleanup needs attention: ${String(error)}`); }
    if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
      tunnel.kill("SIGTERM");
      await new Promise<void>((resolve) => tunnel!.once("exit", () => resolve()));
    }
    await scenario.close();
  }
  if (outcome instanceof Error) throw outcome;
  console.log(JSON.stringify(outcome, null, 2));
}

await run();
