import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionDisplaySubtitle, sessionDisplayTitle } from "../src/session-label.ts";

test("diagnosis sessions default to scenario title", () => {
  assert.equal(
    sessionDisplayTitle({
      title: null,
      workspace_id: "primary",
      execution_mode: "diagnosis",
      diagnosis_scenario: "disk-usage",
    }),
    "磁盘用量异常",
  );
});

test("explicit title wins", () => {
  assert.equal(
    sessionDisplayTitle({
      title: "夜间巡检",
      workspace_id: "primary",
      execution_mode: "diagnosis",
      diagnosis_scenario: "disk-usage",
    }),
    "夜间巡检",
  );
});

test("diagnosis subtitle skips scenario when title already matches", () => {
  assert.equal(
    sessionDisplaySubtitle({
      title: "磁盘用量异常",
      workspace_id: "primary",
      execution_mode: "diagnosis",
      diagnosis_scenario: "disk-usage",
    }),
    "",
  );
});

test("delegation subtitle is single 委派 label", () => {
  assert.equal(
    sessionDisplaySubtitle({
      title: "子任务",
      workspace_id: "primary",
      parent_job_id: "job-1",
    }),
    "委派",
  );
});
