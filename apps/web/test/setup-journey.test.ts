import assert from "node:assert/strict";
import test from "node:test";
import { activeSetupBlocker, setupReadyForDiagnosis, setupSteps } from "../src/setup-journey.ts";

const worker = {
  worker_id: "w1",
  online: 1,
  reconciled: 1,
  blocked: 0,
  schedulable: true,
};

test("setup steps mark model and worker before diagnosis", () => {
  const steps = setupSteps({ modelBound: false, pendingApprovals: 0, workers: [] });
  assert.equal(steps.find((s) => s.id === "ca")?.done, true);
  assert.equal(steps.find((s) => s.id === "model")?.done, false);
  assert.equal(steps.find((s) => s.id === "worker")?.done, false);
});

test("diagnosis is ready only with model and schedulable worker", () => {
  assert.equal(setupReadyForDiagnosis({ modelBound: true, pendingApprovals: 0, workers: [worker] }), true);
  assert.equal(setupReadyForDiagnosis({ modelBound: false, pendingApprovals: 0, workers: [worker] }), false);
  assert.equal(
    setupReadyForDiagnosis({
      modelBound: true,
      pendingApprovals: 0,
      workers: [{ ...worker, schedulable: false, online: 0 }],
    }),
    false,
  );
});

test("active blocker prefers model before worker connectivity", () => {
  assert.equal(activeSetupBlocker({ modelBound: false, pendingApprovals: 0, workers: [] })?.id, "model");
  assert.equal(
    activeSetupBlocker({ modelBound: true, pendingApprovals: 0, workers: [{ ...worker, schedulable: false }] })?.id,
    "worker",
  );
  assert.equal(activeSetupBlocker({ modelBound: true, pendingApprovals: 2, workers: [] }), null);
});
