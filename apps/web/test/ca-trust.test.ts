import { test } from "node:test";
import assert from "node:assert/strict";
import { caFileName, trustGuides } from "../src/ca-trust.ts";

test("the guide covers macOS, Linux, Windows and Firefox in that order", () => {
  assert.deepEqual(trustGuides().map(g => g.id), ["macos", "linux", "windows", "firefox"]);
});

test("every command names the downloaded file, and Firefox has steps but no command", () => {
  for (const guide of trustGuides()) {
    assert.ok(guide.steps.length > 0, guide.id);
    for (const item of guide.commands) {
      assert.ok(item.command.includes(caFileName), `${guide.id}: ${item.label}`);
      assert.ok(!/[\r\n]/.test(item.command), `${guide.id}: ${item.label}`);
    }
  }
  assert.deepEqual(trustGuides().find(g => g.id === "firefox")?.commands, []);
});

test("Linux gives Debian and Fedora commands, and macOS adds to the system keychain", () => {
  const linux = trustGuides().find(g => g.id === "linux")!.commands.map(c => c.label);
  assert.deepEqual(linux, ["Debian / Ubuntu", "Fedora / RHEL"]);
  const mac = trustGuides().find(g => g.id === "macos")!.commands[0].command;
  assert.ok(mac.includes("security add-trusted-cert") && mac.includes("/Library/Keychains/System.keychain"));
});
