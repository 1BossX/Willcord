import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFrame, requestHash, normalizeRepo } from "../src/index.js";
test("shared frame fixtures", () => {
  for (const f of JSON.parse(
    readFileSync(new URL("../fixtures/frames.json", import.meta.url), "utf8"),
  )) {
    if (f.valid) assert.doesNotThrow(() => parseFrame(JSON.stringify(f.frame)));
    else assert.throws(() => parseFrame(JSON.stringify(f.frame)));
  }
});
test("RFC 8785 hash fixtures", () => {
  for (const f of JSON.parse(
    readFileSync(new URL("../fixtures/hashes.json", import.meta.url), "utf8"),
  ))
    assert.equal(requestHash(f.request), f.sha256);
});
test("frame bound and workspace remote identity", () => {
  assert.throws(() => parseFrame(" ".repeat(65537)));
  assert.equal(
    normalizeRepo("git@github.com:1BossX/WorkerPlane.git"),
    normalizeRepo("https://github.com/1BossX/WorkerPlane.git"),
  );
  assert.throws(() => normalizeRepo("file:///tmp/repo"));
});
