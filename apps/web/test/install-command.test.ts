import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { installCommand, installerUrl, isLoopbackOrigin, joinCommand, joinLink } from "../src/install-command.ts";

const FP = "ab".repeat(32);
test("generated command keeps spaces, apostrophes and shell syntax literal", () => {
  const ca = "/tmp/CA dir/o'ne;$(echo INJECTED).pem";
  const command = installCommand("https://plane.internal:8443", ca, true);
  const parsed = execFileSync("bash", ["-c", `curl() { :; }; bash() { printf '%s\\n' "$@"; }; ${command}`], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(parsed, ["-s", "--", "worker", "https://plane.internal:8443", "--ca", ca, "--system"]);
});
test("one link carries the address and the CA fingerprint", () => {
  assert.equal(joinLink("https://plane.internal:8443", FP), `https://plane.internal:8443#sha256=${FP}`);
  assert.equal(joinLink("https://plane.example.com"), "https://plane.example.com");
  for (const bad of ["abc", "A".repeat(64), "ab".repeat(31), ""]) assert.throws(() => joinLink("https://plane.internal", bad));
  assert.throws(() => joinLink("http://plane.internal"));
  assert.throws(() => joinLink("https://plane.internal/path"));
});
test("fresh and installed machines get the same single link argument", () => {
  const link = `'https://plane.internal:8443#sha256=${FP}'`;
  assert.equal(installCommand("https://plane.internal:8443", "", false, FP), `curl -fsSL ${installerUrl} | bash -s -- worker ${link}`);
  assert.equal(joinCommand("https://plane.internal:8443", "", false, FP), `willcord worker join ${link}`);
  // A system service needs sudo and no account: it runs as whoever runs sudo.
  assert.equal(joinCommand("https://plane.internal:8443", "", true, FP), `sudo willcord worker join ${link} --system`);
  assert.ok(!installCommand("https://plane.internal:8443", "", true, FP).includes("--user"));
});
test("the generated link round-trips through the installer's bash parsing", () => {
  const command = installCommand("https://plane.internal:8443", "", false, FP);
  const parsed = execFileSync("bash", ["-c", `curl() { :; }; bash() { printf '%s\\n' "$@"; }; ${command}`], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(parsed, ["-s", "--", "worker", `https://plane.internal:8443#sha256=${FP}`]);
});
test("manual CA and bad input are refused", () => {
  const cmd = installCommand("https://plane.internal:8443", "/tmp/ca.pem", false);
  assert.ok(cmd.includes("--ca '/tmp/ca.pem'") && !cmd.includes("--system") && !cmd.includes("#sha256"));
  assert.throws(() => installCommand("http://plane.internal", "/tmp/ca.pem", false));
  assert.throws(() => installCommand("https://plane.internal/path", "/tmp/ca.pem", false));
  for (const path of ["relative.pem", "/tmp/ca\n.pem", "/tmp/ca\0.pem"]) assert.throws(() => installCommand("https://plane.internal", path, false));
  assert.throws(() => installCommand("https://plane.internal", "/ca.pem", false, FP));
});
test("a main node reached as localhost is flagged", () => {
  for (const o of ["https://localhost:8443", "https://127.0.0.1:8443", "https://[::1]:8443", "https://plane.localhost"]) assert.ok(isLoopbackOrigin(o), o);
  for (const o of ["https://plane.internal:8443", "https://10.8.0.2:8443", "https://localhost.example.com"]) assert.ok(!isLoopbackOrigin(o), o);
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
  assert.ok(installCommand("https://plane.internal", "", false, fingerprint).includes(`#sha256=${fingerprint}`));
  assert.ok(!installCommand("https://plane.example.com", "", false).includes("--ca"));
  assert.throws(() => installCommand("https://plane.internal", "/ca.pem", false, fingerprint));
  assert.throws(() => installCommand("https://plane.internal", "", false, ""));
});
