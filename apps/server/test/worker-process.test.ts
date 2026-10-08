import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestHash } from "@worker-plane/protocol";
import { Peer } from "./support/peer.js";
import { createCertificates, startTlsEndpoint, startWorker, stopWorker, waitFor, type WorkerProcess } from "./support/worker-harness.js";

/** Identity fields of frames that do not carry call_seq. */
const ref = ({ call_seq: _seq, ...rest }: any) => rest;

/** True while a process with this PID exists. */
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Every chunk of a stream through log_fetch, deduplicated by seq. */
async function fetchAll(peer: Peer, id: { worker_id: string; connection_epoch: number; job_id: string; call_id: string; request_hash: string }, stream: string) {
  const chunks = new Map<number, Buffer>();
  for (const f of peer.take("tool_log", (f) => f.call_id === id.call_id && f.stream === stream)) chunks.set(f.seq, Buffer.from(f.data, "base64"));
  for (let from = 0; ;) {
    peer.send({ ...ref(id), type: "log_fetch", stream, from_seq: from });
    const status = await peer.next("log_status", 15000, (f) => f.call_id === id.call_id && f.stream === stream);
    for (const f of peer.take("tool_log", (f) => f.call_id === id.call_id && f.stream === stream)) chunks.set(f.seq, Buffer.from(f.data, "base64"));
    if (status.state !== "more") {
      const seqs = [...chunks.keys()].sort((a, b) => a - b);
      assert.deepEqual(seqs, [...Array(status.chunks).keys()], "chunks are numbered without gaps");
      return { state: status.state, chunks: status.chunks, bytes: Buffer.concat(seqs.map((s) => chunks.get(s)!)) };
    }
    // Live chunks may have been dropped: continue from the first gap.
    for (from = 0; chunks.has(from); from++);
  }
}

test("P4-A real Rust worker: process-group cancel and timeout, bounded output, log replay and disk refusal", { timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-process-"));
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
  const start = (id: string, extraConfig: string) =>
    (worker = startWorker({ dir, id, url: endpoint.url, ca: certs.ca, token: "token", workspace, extraConfig }));
  try {
    start("w", "kill_grace_secs = 1\nmax_tool_timeout_secs = 120\n");
    let peer = await nextPeer();
    await peer.handshake(1);

    // 1. Cancel a command whose shell ignores TERM and whose child shares its group.
    const stubborn = peer.call(1, "c1", 1, "bash", { command: "trap '' TERM; sleep 60 & echo $! > child.pid; echo started >> marker.log; wait", timeout_secs: 60 });
    await peer.next("tool_accepted");
    await waitFor(() => count("started") === 1 && existsSync(join(workspace, "child.pid")));
    const childPid = Number(readFileSync(join(workspace, "child.pid"), "utf8"));
    assert.ok(alive(childPid));
    const cancelSent = Date.now();
    peer.send({ ...stubborn, type: "cancel_call" });
    assert.equal((await peer.next("cancel_ack")).state, "running", "the acknowledgement is only a receipt");
    // The slot stays taken until the stop is confirmed.
    const queued = peer.call(1, "c2", 2, "bash", { command: "echo next >> marker.log" });
    assert.equal((await peer.next("tool_rejected", 15000, (f) => f.call_id === "c2")).reason, "busy");
    const cancelled = await peer.next("tool_result", 15000, (f) => f.call_id === "c1");
    assert.ok(Date.now() - cancelSent >= 1000, "KILL only after the grace period");
    assert.equal(cancelled.result.termination, "cancelled");
    assert.equal(cancelled.result.signal, 9);
    assert.equal(alive(childPid), false, "the whole process group is gone before the result");
    peer.send({ ...stubborn, type: "cancel_call" });
    assert.equal((await peer.next("cancel_ack")).state, "completed", "a repeated cancel is idempotent");
    peer.send({ ...ref(stubborn), type: "tool_ack", ack_through: 1 });
    t.diagnostic(`cancel: call c1 stopped ${Date.now() - cancelSent} ms after cancel_call`);

    // 2. A refused call can be sent again once the worker is free.
    const retried = peer.call(1, "c2", 2, "bash", { command: "echo next >> marker.log" });
    assert.equal(retried.request_hash, queued.request_hash);
    assert.equal((await peer.next("tool_result", 15000, (f) => f.call_id === "c2")).result.exit_code, 0);
    peer.send({ ...ref(retried), type: "tool_ack", ack_through: 2 });
    assert.equal(count("next"), 1);

    // 3. Timeout follows the same TERM path; out-of-range limits are refused unrun.
    const slow = peer.call(1, "c3", 3, "bash", { command: "echo slow >> marker.log; sleep 30", timeout_secs: 1 });
    const timedOut = await peer.next("tool_result", 15000, (f) => f.call_id === "c3");
    assert.equal(timedOut.result.termination, "timeout");
    assert.equal(timedOut.result.signal, 15);
    peer.send({ ...ref(slow), type: "tool_ack", ack_through: 3 });
    for (const [callId, seq, limit] of [["c4", 4, 121], ["c5", 5, 1801]] as const) {
      peer.call(1, callId, seq, "bash", { command: "echo never >> marker.log", timeout_secs: limit });
      assert.equal((await peer.next("tool_rejected", 15000, (f) => f.call_id === callId)).reason, "invalid");
    }
    assert.equal(count("never"), 0);

    // 4. 30 MiB of output never blocks the command; 10 MiB is stored and the rest counted.
    const loud = peer.call(1, "c6", 6, "bash", { command: "head -c 31457280 /dev/zero | tr '\\0' a; echo done >&2" });
    const big = await peer.next("tool_result", 60000, (f) => f.call_id === "c6");
    assert.equal(big.result.exit_code, 0);
    assert.equal(big.result.logs.stdout.bytes_total, 31457280);
    assert.equal(big.result.logs.truncated, true);
    const stdout = await fetchAll(peer, loud, "stdout");
    const stderr = await fetchAll(peer, loud, "stderr");
    assert.equal(stdout.state, "complete");
    assert.equal(stdout.bytes.length, big.result.logs.stdout.bytes_logged);
    assert.equal(stdout.bytes.length + stderr.bytes.length, 10 * 1024 * 1024);
    assert.ok(stdout.bytes.every((b) => b === 0x61));
    t.diagnostic(`large output: ${big.result.logs.stdout.bytes_total} bytes in ${big.result.duration_ms} ms, ${stdout.chunks} chunks stored`);
    // Acknowledged logs and results are deleted; a later fetch says so.
    peer.send({ ...ref(loud), type: "log_ack", stream: "stdout", chunks: stdout.chunks });
    peer.send({ ...ref(loud), type: "log_ack", stream: "stderr", chunks: stderr.chunks });
    const loudLogs = join(dir, "w-data", "logs", createHash("sha256").update("c6").digest("hex"));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(existsSync(loudLogs), "log ACKs alone do not delete output whose result is unacknowledged");
    peer.send({ ...ref(loud), type: "tool_ack", ack_through: 6 });
    await waitFor(() => !existsSync(loudLogs));
    peer.send({ ...ref(loud), type: "log_fetch", stream: "stdout", from_seq: 0 });
    assert.equal((await peer.next("log_status", 15000, (f) => f.call_id === "c6")).state, "expired");

    // 5. Output written while disconnected is fetched afterwards, in order.
    const chatty = peer.call(1, "c7", 7, "bash", { command: "for i in 1 2 3 4 5; do echo line$i; sleep 0.3; done" });
    await peer.next("tool_accepted");
    peer.socket.terminate();
    peer = await nextPeer();
    const second = await peer.handshake(2);
    assert.deepEqual(second.reconcile.calls.map((c: any) => [c.call_id, c.status]), [["c7", "running"]]);
    const replayed = await peer.next("tool_result", 15000, (f) => f.call_id === "c7");
    const id7 = { ...chatty, connection_epoch: 2 };
    const lines = await fetchAll(peer, id7, "stdout");
    assert.equal(lines.bytes.toString(), "line1\nline2\nline3\nline4\nline5\n");
    assert.equal(lines.chunks, replayed.result.logs.stdout.chunks);
    peer.send({ ...ref(id7), type: "tool_ack", ack_through: 7 });

    // 6. A call the ledger never accepted is fenced by cancel and can never start.
    const request = { worker_id: "w", job_id: "job-1", call_id: "c8", call_seq: 8, workspace_id: "repo", config_version: 1, tool: "bash", arguments: { command: "echo fenced >> marker.log" } };
    const ghost = { worker_id: "w", connection_epoch: 2, job_id: "job-1", call_id: "c8", call_seq: 8, request_hash: requestHash(request) };
    peer.send({ ...ghost, type: "cancel_call" });
    assert.equal((await peer.next("cancel_ack")).state, "fenced");
    peer.send({ ...ghost, type: "cancel_call" });
    assert.equal((await peer.next("cancel_ack")).state, "fenced");
    peer.call(2, "c8", 8, "bash", request.arguments);
    assert.equal((await peer.next("tool_rejected")).reason, "cancelled");
    assert.equal(count("fenced"), 0);
    await stopWorker(worker!, "SIGINT");

    // 7. Too little free space refuses new calls without recording them.
    start("full", "min_free_bytes = 1152921504606846976\n");
    peer = await nextPeer();
    await peer.handshake(1, "full");
    peer.call(1, "f1", 1, "bash", { command: "echo full >> marker.log" }, "full");
    assert.equal((await peer.next("tool_rejected")).reason, "disk_full");
    await stopWorker(worker!, "SIGINT");
    start("full", "min_free_bytes = 0\n");
    peer = await nextPeer();
    const reopened = await peer.handshake(1, "full");
    assert.deepEqual(reopened.reconcile.calls, [], "a refused call leaves no ledger record");
    assert.equal(count("full"), 0);
  } catch (error) {
    throw new Error(`${error}\nworker stderr:\n${worker?.stderr()}`, { cause: error });
  } finally {
    if (worker) await stopWorker(worker);
    await endpoint.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4-A an unknown call is settled by resolve_call and never runs again", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-resolve-"));
  const certs = createCertificates(dir);
  const peers: Peer[] = [];
  const endpoint = await startTlsEndpoint(certs, (socket) => peers.push(new Peer(socket)));
  const workspace = join(dir, "workspace");
  const marker = join(workspace, "marker.log");
  const count = (tag: string) => existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter((l) => l === tag).length : 0;
  const start = () => startWorker({ dir, id: "w", url: endpoint.url, ca: certs.ca, token: "token", workspace });
  let worker = start();
  try {
    await waitFor(() => peers.length === 1, 20000);
    let peer = peers[0];
    await peer.handshake(1);
    const lost = peer.call(1, "u1", 1, "bash", { command: "echo lost >> marker.log; sleep 30" });
    await peer.next("tool_accepted");
    await waitFor(() => count("lost") === 1);
    await stopWorker(worker);
    worker = start();
    await waitFor(() => peers.length === 2, 20000);
    peer = peers[1];
    const report = await peer.handshake(2);
    assert.deepEqual(report.reconcile.calls.map((c: any) => [c.call_id, c.status]), [["u1", "unknown"]]);
    peer.call(2, "u2", 2, "bash", { command: "echo after >> marker.log" });
    assert.equal((await peer.next("tool_rejected")).reason, "unknown", "unknown execution blocks the worker");
    const id = { ...lost, connection_epoch: 2 };
    peer.send({ ...id, type: "resolve_call" });
    assert.equal((await peer.next("resolve_ack")).state, "resolved");
    peer.send({ ...id, type: "resolve_call" });
    assert.equal((await peer.next("resolve_ack")).state, "not_unknown", "resolving is idempotent");
    peer.call(2, "u1", 1, "bash", { command: "echo lost >> marker.log; sleep 30" });
    assert.equal((await peer.next("tool_rejected")).reason, "retired", "a settled call never revives");
    peer.call(2, "u2", 2, "bash", { command: "echo after >> marker.log" });
    assert.equal((await peer.next("tool_result")).result.exit_code, 0);
    assert.equal(count("lost"), 1);
    assert.equal(count("after"), 1);
  } finally {
    await stopWorker(worker);
    await endpoint.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
