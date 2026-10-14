import { test } from "node:test";
import assert from "node:assert/strict";
import { jobFailureSummary, localizeToolError } from "../src/job-failures.ts";

test("model turn budget explains tool count separately", () => {
  const text = jobFailureSummary({
    end_reason: "budget_model_turns",
    model_turns: 20,
    max_model_turns: 20,
    tool_calls_used: 33,
    max_tool_calls: 200,
  });
  assert.match(text ?? "", /模型轮次/);
  assert.match(text ?? "", /33\/200/);
});

test("localizes common tool errors", () => {
  assert.equal(localizeToolError("permission denied"), "权限不足");
});

test("command not found beats generic not found", () => {
  assert.equal(localizeToolError("bash: foo: command not found"), "命令未找到");
});
