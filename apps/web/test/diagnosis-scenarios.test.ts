import assert from "node:assert/strict";
import test from "node:test";
import { diagnosisScenarios, scenarioById } from "../src/diagnosis-scenarios.ts";

test("three first-diagnosis scenarios are defined", () => {
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

test("scenario lookup by id", () => {
  assert.equal(scenarioById("disk-usage")?.title, "磁盘用量异常");
  assert.equal(scenarioById("missing" as "disk-usage"), undefined);
});
