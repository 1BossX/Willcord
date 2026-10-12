import assert from "node:assert/strict";
import test from "node:test";
import { isTlsOrNetworkFailure, loginFailureMessage } from "../src/login-connectivity.ts";

test("login maps TLS failures to the CA trust blocker", () => {
  const message = loginFailureMessage(new TypeError("Failed to fetch"));
  assert.match(message, /信任/);
  assert.match(message, /willcord trust-ca/);
});

test("login keeps a normal wrong-password message", () => {
  assert.equal(loginFailureMessage({ status: 401 }), "密码不正确，请重试。");
});

test("network heuristics cover common browser errors", () => {
  assert.equal(isTlsOrNetworkFailure(new TypeError("NetworkError")), true);
  assert.equal(isTlsOrNetworkFailure(new Error("net::ERR_CERT_AUTHORITY_INVALID")), true);
  assert.equal(isTlsOrNetworkFailure(new Error("disk full")), false);
});
