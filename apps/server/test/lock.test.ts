import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireOwnerLock } from "../src/lock.js";

test("main data directory lock fails closed for concurrent instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-owner-"));
  try {
    const release = acquireOwnerLock(dir);
    const owner = JSON.parse(
      readFileSync(join(dir, "main.lock", "owner.json"), "utf8"),
    );
    assert.equal(owner.pid, process.pid);
    assert.throws(() => acquireOwnerLock(dir), { code: "EEXIST" });
    release();
    const nextRelease = acquireOwnerLock(dir);
    nextRelease();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
