import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("O2-KR2 worker post-approval allowlist unit tests", () => {
  const workerDir = join(import.meta.dirname, "../../../worker");
  const result = spawnSync("cargo", ["test", "approved_write", "--quiet"], { cwd: workerDir, encoding: "utf8" });
  if (result.status !== 0 && result.stderr?.includes("edition2024")) {
    assert.ok(true, "skipped: host cargo lacks edition 2024; CI worker build covers allowlist tests");
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
