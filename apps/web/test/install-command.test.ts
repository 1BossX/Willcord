import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { installCommand } from "../src/install-command.ts";

test("generated command keeps spaces, apostrophes and shell syntax literal", () => {
  const ca = "/tmp/CA dir/o'ne;$(echo INJECTED).pem";
  const command = installCommand("https://plane.internal:8443", ca, true, "ops");
  const parsed = execFileSync("bash", ["-c", `curl() { :; }; bash() { printf '%s\\n' "$@"; }; ${command}`], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(parsed, ["-s", "--", "worker", "--server", "https://plane.internal:8443", "--ca", ca, "--system", "--user", "ops"]);
});
test("user install excludes service account flags and credentials", () => {
  const cmd = installCommand("https://plane.internal:8443", "/tmp/ca.pem", false, "unused");
  assert.ok(!cmd.includes("--system") && !cmd.includes("unused"));
  assert.throws(() => installCommand("http://plane.internal", "/tmp/ca.pem", false, ""));
  assert.throws(() => installCommand("https://plane.internal/path", "/tmp/ca.pem", false, ""));
  for (const path of ["relative.pem", "/tmp/ca\n.pem", "/tmp/ca\0.pem"]) assert.throws(() => installCommand("https://plane.internal", path, false, ""));
  for (const user of ["", "root", "-ops", "ops;id"]) assert.throws(() => installCommand("https://plane.internal", "/tmp/ca.pem", true, user));
});

test("CA fingerprint uses DER, rejects multiple certificates and supports pin/system modes", async () => {
  const { certificateFingerprint } = await import("../src/install-command.ts");
  const { createHash } = await import("node:crypto");
  const der = Buffer.from([48, 3, 1, 2, 3]);
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----\n`;
  const fingerprint = await certificateFingerprint(pem);
  assert.equal(fingerprint, createHash("sha256").update(der).digest("hex"));
  assert.notEqual(fingerprint, createHash("sha256").update(pem).digest("hex"));
  await assert.rejects(certificateFingerprint(pem + pem));
  await assert.rejects(certificateFingerprint("x".repeat(65537)));
  const command = installCommand("https://plane.internal", "", false, "", fingerprint);
  assert.ok(command.includes("'--ca-fingerprint'"));
  assert.ok(!installCommand("https://plane.example.com", "", false, "").includes("'--ca'"));
  assert.throws(() => installCommand("https://plane.internal", "/ca.pem", false, "", fingerprint));
  assert.throws(() => installCommand("https://plane.internal", "", false, "", ""));
});
