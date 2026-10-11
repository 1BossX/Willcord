import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestHash } from "@willcord/protocol";
import { Peer } from "./support/peer.js";
import { createCertificates, startTlsEndpoint, startWorker, stopWorker, waitFor, type WorkerProcess } from "./support/worker-harness.js";

test("real Rust worker ledger: lost ACKs, network loss, crash windows and tombstones never repeat side effects", { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "willcord-ledger-"));
  const certs = createCertificates(dir);
  const peers: Peer[] = [];
  const endpoint = await startTlsEndpoint(certs, (socket) => peers.push(new Peer(socket)));
  const workspace = join(dir, "workspace");
  const marker = join(workspace, "marker.log");
  const count = (tag: string) => existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter((l) => l === tag).length : 0;
  let worker: WorkerProcess | undefined;
  let connections = 0;
  const nextPeer = async () => {
    await waitFor(() => {
      if (worker && worker.child.exitCode !== null) throw new Error(worker.stderr());
      return peers.length > connections;
    }, 20000);
    return peers[connections++];
  };
  const handshake = async (peer: Peer, epoch: number, workerId = "w") => {
    const register = await peer.next("register");
    peer.send({ type: "register_ack", worker_id: workerId, connection_epoch: epoch, reconciliation_required: true });
    await peer.next("resume");
    peer.send({ type: "ack", worker_id: workerId, connection_epoch: epoch, ack_type: "resume" });
    const reconcile = await peer.next("reconcile");
    peer.send({ type: "ack", worker_id: workerId, connection_epoch: epoch, ack_type: "reconcile" });
    await peer.next("worker_ready");
    return { register, reconcile };
  };
  const call = (peer: Peer, epoch: number, callId: string, seq: number, command: string, workerId = "w") => {
    const request = { worker_id: workerId, job_id: "job-1", call_id: callId, call_seq: seq, workspace_id: "repo", config_version: 1, tool: "bash", arguments: { command } };
    const hash = requestHash(request);
    peer.send({ type: "tool_call", connection_epoch: epoch, request_hash: hash, ...request });
    return hash;
  };
  const ack = (peer: Peer, epoch: number, callId: string, hash: string, through: number, workerId = "w") =>
    peer.send({ type: "tool_ack", worker_id: workerId, connection_epoch: epoch, job_id: "job-1", call_id: callId, request_hash: hash, ack_through: through });
  const start = (id = "w", retentionSecs?: number) =>
    (worker = startWorker({ dir, id, url: endpoint.url, ca: certs.ca, token: "token", workspace, retentionSecs }));
  try {
    start();
    // 1. Result delivered but its ACK lost with the connection.
    let peer = await nextPeer();
    const first = await handshake(peer, 1);
    assert.deepEqual(first.reconcile.calls, []);
    const one = call(peer, 1, "c1", 1, "echo one >> marker.log");
    assert.equal((await peer.next("tool_accepted")).boot_id, first.register.boot_id);
    const result = await peer.next("tool_result");
    assert.equal(result.result.exit_code, 0);
    peer.socket.terminate();
    peer = await nextPeer();
    const second = await handshake(peer, 2);
    assert.equal(second.register.boot_id, first.register.boot_id, "network loss is not a restart");
    assert.deepEqual(second.reconcile.calls.map((c: any) => [c.call_id, c.status]), [["c1", "completed"]]);
    const resent = await peer.next("tool_result");
    assert.equal(resent.connection_epoch, 2);
    assert.deepEqual(resent.result, result.result);
    ack(peer, 2, "c1", one, 1);
    // A duplicate frame returns the cached result; a changed request is a conflict.
    call(peer, 2, "c1", 1, "echo one >> marker.log");
    assert.deepEqual((await peer.next("tool_result")).result, result.result);
    call(peer, 2, "c1", 1, "echo forged >> marker.log");
    assert.equal((await peer.next("tool_rejected")).reason, "conflict");
    call(peer, 2, "c1-replay", 1, "echo replay >> marker.log");
    assert.equal((await peer.next("tool_rejected")).reason, "conflict");
    assert.equal(count("one"), 1);

    // 2. The network drops while a command runs; the command keeps running.
    const two = call(peer, 2, "c2", 2, "sleep 1; echo two >> marker.log");
    await peer.next("tool_accepted");
    peer.socket.terminate();
    peer = await nextPeer();
    const third = await handshake(peer, 3);
    assert.equal(third.reconcile.calls[0].call_id, "c2");
    assert.equal(third.reconcile.calls[0].boot_id, first.register.boot_id);
    assert.equal((await peer.next("tool_result")).call_id, "c2");
    ack(peer, 3, "c2", two, 2);
    assert.equal(count("two"), 1);

    // 3. The process dies after the side effect but before the result is stored.
    call(peer, 3, "c3", 3, "echo three >> marker.log; sleep 30");
    await peer.next("tool_accepted");
    await waitFor(() => count("three") === 1);
    await stopWorker(worker!);
    start();
    peer = await nextPeer();
    const fourth = await handshake(peer, 4);
    assert.notEqual(fourth.register.boot_id, first.register.boot_id);
    assert.equal(fourth.register.ledger_id, first.register.ledger_id);
    assert.deepEqual(fourth.reconcile.calls.map((c: any) => [c.call_id, c.status]), [["c3", "unknown"]]);
    call(peer, 4, "c3", 3, "echo three >> marker.log; sleep 30");
    assert.equal((await peer.next("tool_rejected")).reason, "unknown");
    call(peer, 4, "c4", 4, "echo four >> marker.log");
    assert.equal((await peer.next("tool_rejected")).reason, "unknown", "unknown execution blocks the worker");
    assert.equal(count("three"), 1);
    assert.equal(count("four"), 0);
    await stopWorker(worker!);

    // 4. Retired results leave a tombstone that refuses old frames.
    start("r", 0);
    peer = await nextPeer();
    await handshake(peer, 1, "r");
    const retired = call(peer, 1, "r1", 1, "echo retired >> marker.log", "r");
    await peer.next("tool_accepted");
    await peer.next("tool_result");
    ack(peer, 1, "r1", retired, 1, "r");
    call(peer, 1, "r1", 1, "echo retired >> marker.log", "r");
    assert.equal((await peer.next("tool_rejected")).reason, "retired");
    assert.equal(count("retired"), 1);
  } finally {
    if (worker) await stopWorker(worker);
    await endpoint.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Rust worker exits on SIGINT that arrives while it is inside a frame handler", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "willcord-sigint-"));
  const certs = createCertificates(dir);
  const peers: Peer[] = [];
  const endpoint = await startTlsEndpoint(certs, (socket) => peers.push(new Peer(socket)));
  const worker = startWorker({ dir, id: "w", url: endpoint.url, ca: certs.ca, token: "token", workspace: join(dir, "workspace") });
  try {
    await waitFor(() => peers.length > 0, 20000);
    const peer = peers[0];
    await peer.next("register");
    peer.send({ type: "register_ack", worker_id: "w", connection_epoch: 1, reconciliation_required: true });
    await peer.next("resume");
    peer.send({ type: "ack", worker_id: "w", connection_epoch: 1, ack_type: "resume" });
    await peer.next("reconcile");
    peer.send({ type: "ack", worker_id: "w", connection_epoch: 1, ack_type: "reconcile" });
    await peer.next("worker_ready");
    // A chunked write keeps the worker inside the tool_call handler until the final chunk.
    const base = { worker_id: "w", connection_epoch: 1, job_id: "job-1", call_id: "chunked", request_hash: "0".repeat(64) };
    peer.send({ ...base, type: "tool_call", call_seq: 1, workspace_id: "repo", config_version: 1, tool: "write", arguments: { path: "big.txt", expected_hash: "missing", transfer_bytes: 2, transfer_sha256: "0".repeat(64), transfer_chunks: 2 } });
    peer.send({ ...base, type: "tool_data", chunk_index: 0, data: Buffer.from("a").toString("base64"), final: false });
    await new Promise((r) => setTimeout(r, 500));
    worker.child.kill("SIGINT");
    const exited = await Promise.race([worker.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
    assert.ok(exited, `SIGINT was lost: ${worker.stderr()}`);
    assert.equal(worker.child.exitCode, 0);
  } finally {
    await stopWorker(worker);
    await endpoint.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
