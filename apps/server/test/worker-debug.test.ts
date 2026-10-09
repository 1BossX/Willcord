// `worker-plane-worker debug` against a real main node behind TLS: it proves the
// CA chain and the route without registering, so a running worker is untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { startScenario, workerToken } from "./support/main-node.js";
import { repoRoot } from "./support/worker-harness.js";

const debug = (config: string, env: Record<string, string>) =>
  new Promise<{ code: number; report: any }>((resolve) => {
    execFile(join(repoRoot, "worker/target/debug/worker-plane-worker"), ["debug", "--json", config], { env: { PATH: process.env.PATH!, ...env } },
      (error, stdout) => resolve({ code: error ? (error as any).code : 0, report: JSON.parse(stdout) }));
  });

test("worker debug passes beside a running worker and does not disturb it", { timeout: 30000 }, async () => {
  const s = await startScenario({ scripts: {} });
  try {
    s.startWorker();
    await s.ready();
    const before = s.one("SELECT connection_epoch FROM workers WHERE worker_id='w'").connection_epoch;
    const config = join(s.dir, "w.toml");
    const { code, report } = await debug(config, { WORKER_TOKEN: workerToken, SSL_CERT_FILE: join(s.dir, "ca.pem") });
    assert.equal(code, 0, JSON.stringify(report));
    const by = Object.fromEntries(report.checks.map((c: any) => [c.name, c]));
    assert.deepEqual(Object.keys(by), ["config", "token", "data_dir", "ledger", "disk", "tls"]);
    assert.equal(by.data_dir.detail, "locked by a running worker");
    assert.match(by.ledger.detail, /^integrity ok/);
    assert.match(by.tls.detail, /certificate trusted/);
    const after = s.one("SELECT online,reconciled,connection_epoch FROM workers WHERE worker_id='w'");
    assert.deepEqual(after, { online: 1, reconciled: 1, connection_epoch: before }, "the probe never replaced the live connection");

    const untrusted = await debug(config, { WORKER_TOKEN: workerToken, SSL_CERT_FILE: "/nonexistent" });
    assert.equal(untrusted.code, 1);
    assert.equal(untrusted.report.checks.find((c: any) => c.name === "tls").ok, false);
    const tokenless = await debug(config, { SSL_CERT_FILE: join(s.dir, "ca.pem") });
    assert.equal(tokenless.report.checks.find((c: any) => c.name === "token").ok, false);
  } finally {
    await s.close();
  }
});
