import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const base = { MODEL_API_KEY: "test-key" };

test("HOST defaults to loopback, accepts an IP for containers and rejects names", () => {
  assert.equal(loadConfig(base).host, "127.0.0.1");
  assert.equal(loadConfig({ ...base, HOST: "0.0.0.0" }).host, "0.0.0.0");
  assert.equal(loadConfig({ ...base, HOST: "::" }).host, "::");
  assert.throws(() => loadConfig({ ...base, HOST: "main.internal" }), /HOST must be an IP address/);
});
