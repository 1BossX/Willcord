import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosisExecutionPolicyText } from "../src/diagnosis-policy.js";
import { diagnosisAnswerFormat } from "../src/diagnosis-scenarios.js";

test("diagnosis policy text lists expanded bash allowlist", () => {
  const text = diagnosisExecutionPolicyText();
  assert.match(text, /docker ps\|inspect\|logs\|info/);
  assert.match(text, /\/etc\/os-release/);
  assert.match(text, /write/);
});

test("diagnosis answer format includes execution policy for the model", () => {
  const format = diagnosisAnswerFormat("docker-service");
  assert.match(format, /docker info|docker ps/);
  assert.match(format, /\/etc\/os-release/);
});
