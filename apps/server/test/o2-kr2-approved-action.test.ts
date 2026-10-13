import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionBinding } from "../src/approved-action.js";
import { Peer } from "./support/peer.js";
import { createCertificates, startTlsEndpoint, startWorker, stopWorker, waitFor } from "./support/worker-harness.js";

test("O2-KR2 worker post-approval allowlist unit tests", () => {
  const workerDir = join(import.meta.dirname, "../../../worker");
  const toolchain = process.env.RUSTUP_TOOLCHAIN ?? "+1.88.0";
  const cargo = toolchain.startsWith("+") ? ["cargo", toolchain, "test", "approved_write", "--quiet"] : ["cargo", "test", "approved_write", "--quiet"];
  const result = spawnSync(cargo[0], cargo.slice(1), { cwd: workerDir, encoding: "utf8", env: { ...process.env, RUSTUP_TOOLCHAIN: toolchain.startsWith("+") ? toolchain.slice(1) : process.env.RUSTUP_TOOLCHAIN } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("O2-KR2 bound execute path on the worker", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "willcord-kr2-exec-"));
  const certs = createCertificates(dir);
  const peers: Peer[] = [];
  const endpoint = await startTlsEndpoint(certs, (socket) => peers.push(new Peer(socket)));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const worker = startWorker({ dir, id: "kr2-exec", url: endpoint.url, ca: certs.ca, token: "token", workspace });
  try {
    const peer = await (async () => {
      await waitFor(() => peers.length > 0, 20000);
      return peers[0];
    })();
    await peer.handshake(1, "kr2-exec");
    const args = { command: "docker restart web" };
    const binding = actionBinding("kr2-exec", "bash", args);
    const wrong = { command: "docker restart other" };
    peer.call(1, "bad", 1, "bash", wrong, "kr2-exec", "approved", binding);
    assert.equal((await peer.next("tool_rejected", 15000, (f) => f.call_id === "bad")).reason, "invalid");
    peer.call(1, "good", 2, "bash", args, "kr2-exec", "approved", binding);
    assert.equal((await peer.next("tool_accepted", 15000, (f) => f.call_id === "good")).call_id, "good");
    peer.call(1, "diag", 3, "bash", args, "kr2-exec", "diagnosis");
    assert.equal((await peer.next("tool_rejected", 15000, (f) => f.call_id === "diag")).reason, "invalid");
  } finally {
    stopWorker(worker);
    rmSync(dir, { recursive: true, force: true });
  }
});
