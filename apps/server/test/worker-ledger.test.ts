import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { requestHash } from "@worker-plane/protocol";
import { createCertificates, startTlsEndpoint, startWorker, stopWorker, waitFor, type WorkerProcess } from "./support/worker-harness.js";

/** Scripted main node: the test decides every frame the worker receives. */
class Peer {
  private frames: any[] = [];
  private waiter?: () => void;
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "heartbeat") return;
      this.frames.push(frame);
      this.waiter?.();
    });
  }
  async next(type: string, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.frames.length) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((r) => { this.waiter = r; setTimeout(r, 50); });
    }
    const frame = this.frames.shift();
    assert.equal(frame.type, type, JSON.stringify(frame));
    return frame;
  }
  send(frame: object) { this.socket.send(JSON.stringify({ protocol_version: 1, ...frame })); }
}

test("real Rust worker ledger: lost ACKs, network loss, crash windows and tombstones never repeat side effects", { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-ledger-"));
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
