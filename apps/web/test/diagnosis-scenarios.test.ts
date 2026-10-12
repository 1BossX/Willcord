import assert from "node:assert/strict";
import test from "node:test";
import { diagnosisScenarios } from "../src/diagnosis-scenarios.ts";

test("three diagnosis scenarios are defined", () => {
  assert.deepEqual(diagnosisScenarios.map((s) => s.id), [
    "docker-service",
    "disk-usage",
    "post-deploy",
  ]);
  for (const scenario of diagnosisScenarios) {
    assert.match(scenario.prompt, /结论、证据和建议的下一步/);
    assert.match(scenario.prompt, /无法确认/);
  }
});

test("post-deploy prompt names Willcord release, trust-ca, and Caddy loopback exclusions", () => {
  const post = diagnosisScenarios.find((s) => s.id === "post-deploy")!;
  assert.match(post.prompt, /Willcord 发版/);
  assert.match(post.prompt, /trust-ca/);
  assert.match(post.prompt, /Caddy 回环/);
});
