import { test } from "node:test";
import assert from "node:assert/strict";
import { apiErrorMessage } from "../src/api.ts";

test("known error codes keep their sentence", () => {
  assert.equal(apiErrorMessage(400, "note_required"), "请填写说明。");
  assert.equal(apiErrorMessage(401, "unauthorized"), "登录状态已过期，请重新登录。");
});

test("an unexplained 429 hints at retrying later instead of the generic line", () => {
  // The rate limiter answers with fastify's generic body, whose error field is no code.
  assert.equal(apiErrorMessage(429, "Too Many Requests"), "操作太频繁，请稍后再试。");
  assert.equal(apiErrorMessage(429, undefined), "操作太频繁，请稍后再试。");
});

test("a 429 carrying a known code still prefers that code", () => {
  assert.equal(apiErrorMessage(429, "disk_low"), "数据目录空间不足，空间恢复后会自动继续调度。");
});

test("other statuses without a known code fall back to the generic line", () => {
  assert.equal(apiErrorMessage(500, undefined), "暂时无法完成请求，请稍后重试。");
  assert.equal(apiErrorMessage(500, "not_a_code"), "暂时无法完成请求，请稍后重试。");
});

test("non-string codes are ignored, not looked up on the errors object", () => {
  assert.equal(apiErrorMessage(500, { toString: () => "unauthorized" }), "暂时无法完成请求，请稍后重试。");
});
