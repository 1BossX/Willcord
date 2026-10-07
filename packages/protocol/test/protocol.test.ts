import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseFrame,
  stringifyFrame,
  requestHash,
  normalizeRepo,
  MAX_FRAME_BYTES,
} from "../src/index.js";
test("shared frame fixtures", () => {
  for (const f of JSON.parse(
    readFileSync(new URL("../fixtures/frames.json", import.meta.url), "utf8"),
  )) {
    if (f.valid) assert.deepEqual(parseFrame(stringifyFrame(f.frame)), f.frame);
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
  assert.equal(
    MAX_FRAME_BYTES,
    JSON.parse(
      readFileSync(new URL("../schema.json", import.meta.url), "utf8"),
    )["x-max-frame-bytes"],
  );
  assert.throws(() => parseFrame(" ".repeat(MAX_FRAME_BYTES + 1)));
  const id = normalizeRepo("git@github.com:1BossX/WorkerPlane.git");
  assert.equal(id, "github.com/1BossX/WorkerPlane");
  assert.equal(id, normalizeRepo("https://github.com/1BossX/WorkerPlane.git/"));
  assert.equal(
    id,
    normalizeRepo("ssh://git@github.com/1BossX/WorkerPlane.git"),
  );
  assert.throws(() => normalizeRepo("https://github.com/WorkerPlane.git"));
  assert.throws(() => normalizeRepo("file:///tmp/repo"));
});
