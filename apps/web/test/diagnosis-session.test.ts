import assert from "node:assert/strict";
import test from "node:test";
import { canReuseDiagnosisSession } from "../src/diagnosis-session.ts";

const base = {
  kind: "worker" as const,
  worker_id: "w1",
  execution_mode: "diagnosis" as const,
  diagnosis_scenario: "docker-service" as const,
};

test("reuses empty diagnosis session only when scenario matches", () => {
  assert.equal(canReuseDiagnosisSession(base, "w1", "docker-service", false, false), true);
  assert.equal(canReuseDiagnosisSession(base, "w1", "disk-usage", false, false), false);
  assert.equal(canReuseDiagnosisSession({ ...base, diagnosis_scenario: "post-deploy" }, "w1", "post-deploy", false, false), true);
  assert.equal(canReuseDiagnosisSession(base, "w1", "docker-service", true, false), false);
  assert.equal(canReuseDiagnosisSession(base, "w2", "docker-service", false, false), false);
});
