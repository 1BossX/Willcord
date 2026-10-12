import { test } from "node:test";
import assert from "node:assert/strict";
import { caFileName, fingerprintCheckNote, trustGuides, trustLinkCommand } from "../src/ca-trust.ts";

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

test("the fingerprint note never presents the login page or an admin channel as the trust source", () => {
  assert.ok(!fingerprintCheckNote.includes("管理员渠道"));
  assert.ok(fingerprintCheckNote.includes("已信任或独立的渠道"));
  assert.ok(fingerprintCheckNote.includes("页面本身不能证明它可信"));
  assert.ok(fingerprintCheckNote.includes("逐位核对"));
});

test("the trust command leaves the fingerprint to the independent channel, not the page", () => {
  assert.ok(trustLinkCommand.includes("<已从独立渠道核对的指纹>"));
  assert.ok(!/sha256=[0-9a-f]{8}/i.test(trustLinkCommand));
  assert.ok(!/[\r\n]/.test(trustLinkCommand));
});
