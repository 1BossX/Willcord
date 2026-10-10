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
