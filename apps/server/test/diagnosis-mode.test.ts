import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestHash } from "@willcord/protocol";
import { openDatabase } from "../src/storage.js";
import { ExecutionCoordinator } from "../src/execution.js";
import { Peer } from "./support/peer.js";
import { createCertificates, startTlsEndpoint, startWorker, stopWorker, waitFor, type WorkerProcess } from "./support/worker-harness.js";

test("O2-KR1 diagnosis mode refuses writes and unauthorized bash before execution", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "willcord-diagnosis-"));
  const certs = createCertificates(dir);
  const peers: Peer[] = [];
  const endpoint = await startTlsEndpoint(certs, (socket) => peers.push(new Peer(socket)));
  const workspace = join(dir, "workspace");
  const target = join(workspace, "must-not-exist.txt");
  let worker: WorkerProcess | undefined;
  try {
    worker = startWorker({ dir, id: "diag-w", url: endpoint.url, ca: certs.ca, token: "token", workspace });
    const peer = await (async () => {
      await waitFor(() => peers.length > 0, 20000);
      return peers[0];
    })();
    await peer.handshake(1, "diag-w");

    const writeArgs = { path: "must-not-exist.txt", content: "secret", expected_hash: "missing" };
    const bytes = Buffer.from(writeArgs.content, "utf8");
    const writeHash = requestHash({
      worker_id: "diag-w",
      job_id: "job-1",
      call_id: "w1",
      call_seq: 1,
      workspace_id: "repo",
      config_version: 1,
      tool: "write",
      arguments: writeArgs,
      execution_mode: "diagnosis",
    });
    const { content: _content, ...writeRest } = writeArgs;
    const writeIdentity = {
      worker_id: "diag-w",
      connection_epoch: 1,
      job_id: "job-1",
      call_id: "w1",
      request_hash: writeHash,
    };
    peer.send({
      type: "tool_call",
      ...writeIdentity,
      call_seq: 1,
      workspace_id: "repo",
      config_version: 1,
      tool: "write",
      execution_mode: "diagnosis",
      arguments: {
        ...writeRest,
        transfer_bytes: bytes.length,
        transfer_sha256: createHash("sha256").update(bytes).digest("hex"),
        transfer_chunks: 1,
      },
    });
    peer.send({ type: "tool_data", ...writeIdentity, chunk_index: 0, data: bytes.toString("base64"), final: true });
    assert.equal((await peer.next("tool_rejected")).reason, "invalid");
    assert.equal(existsSync(target), false);

    for (const [callId, seq, command] of [
      ["b1", 2, "docker restart web"],
      ["b2", 3, "rm -rf /tmp/x"],
      ["b3", 4, "cat /etc/shadow"],
      ["b-chain", 6, "docker ps & touch pr75-chain-marker"],
    ] as const) {
      peer.call(1, callId, seq, "bash", { command }, "diag-w", "diagnosis");
      assert.equal((await peer.next("tool_rejected", 15000, (f) => f.call_id === callId)).reason, "invalid");
    }
    assert.equal(existsSync(join(workspace, "pr75-chain-marker")), false);

    peer.call(1, "b4", 5, "bash", { command: "docker ps" }, "diag-w", "diagnosis");
    assert.equal((await peer.next("tool_accepted")).call_id, "b4");
    await peer.next("tool_result", 30000, (f) => f.call_id === "b4");
  } finally {
    if (worker) stopWorker(worker);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diagnosis mode is bound to the session request hash on the main node", async () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES ('venus','boot','ledger',2,1,1,0,?)").run(Date.now());
  db.prepare("INSERT INTO worker_slots(worker_id) VALUES('venus')").run();
  db.prepare("INSERT INTO workspaces VALUES('venus','primary',1,'/tmp','github.com/acme/repo',1)").run();
  db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,execution_mode) VALUES('s','worker','venus','primary',1,'github.com/acme/repo','/tmp','diagnosis')").run();
  db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at) VALUES('j','s','r','h','run','venus',1,'running',?)").run(Date.now());
  db.prepare("UPDATE worker_slots SET active_job_id='j'").run();
  const sent: any[] = [];
  const socket = { readyState: 1, send: (v: string) => sent.push(JSON.parse(v)) };
  const connections = new Map([["venus", { epoch: 2, socket, tokenDigest: "token" }]]);
  const coordinator = new ExecutionCoordinator(db, connections, Date.now, () => new Promise(() => {}));
  const commit = (callId: string, seq: number, tool: string, args: object) => {
    const request = {
      worker_id: "venus",
      job_id: "j",
      call_id: callId,
      call_seq: seq,
      workspace_id: "primary",
      config_version: 1,
      tool,
      arguments: args,
      execution_mode: "diagnosis",
    };
    const h = requestHash(request);
    db.prepare("INSERT INTO runtime_turns VALUES('j',?,'{}','h',?)").run(`turn-${callId}`, Date.now());
    db.prepare("INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES('j',?,?,?,?,?,?,'committed')").run(`turn-${callId}`, callId, seq, h, tool, JSON.stringify(args));
    return h;
  };
  const hash = commit("c1", 1, "bash", { command: "docker compose up" });
  const call = coordinator.dispatch("j", "c1");
  coordinator.receive({
    protocol_version: 1,
    type: "tool_rejected",
    worker_id: "venus",
    connection_epoch: 2,
    job_id: "j",
    call_id: "c1",
    request_hash: hash,
    reason: "invalid",
  });
  assert.deepEqual(await call, { ok: false, result: { error: "not_executed:invalid", not_executed: true, reason: "invalid" } });
  assert.equal(sent[0].execution_mode, "diagnosis");
  assert.equal((db.prepare("SELECT status FROM runtime_calls WHERE call_id='c1'").get() as any).status, "not_executed");
  coordinator.close();
  db.close();
});
