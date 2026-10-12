import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildDiagnosisReport } from "../src/diagnosis-report.js";
import type { DiagnosisScenarioId } from "../src/diagnosis-scenarios.js";

const repoRoot = join(import.meta.dirname, "../../..");
const casesRoot = join(repoRoot, "fixtures/diagnosis/cases");
const forbidden = /[|;&`<>$]|&&|\|\||\$\(/;

type CaseFile = {
  schema_version: number;
  case_id: string;
  scenario_id: DiagnosisScenarioId;
  probes: { call_id: string; tool: string; command: string }[];
  expected: {
    inconclusive: boolean;
    reference_summary: string;
    probe_outputs_contain?: Record<string, string[]>;
    conclusion_must_not_match?: string[];
  };
};

function loadCases(): { slug: string; case: CaseFile }[] {
  return readdirSync(casesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      slug: d.name,
      case: JSON.parse(readFileSync(join(casesRoot, d.name, "case.json"), "utf8")) as CaseFile,
    }));
}

test("diagnosis fixture catalog has four O1-KR1 cases", () => {
  const cases = loadCases();
  assert.equal(cases.length, 4);
  const ids = cases.map((c) => c.case.case_id).sort();
  assert.deepEqual(ids, [
    "o1-kr1-001-docker-exited",
    "o1-kr1-002-disk-near-full",
    "o1-kr1-003-post-deploy-health-fail",
    "o1-kr1-004-inconclusive-healthy",
  ]);
});

test("fixture probe commands avoid shell operators", () => {
  for (const { slug, case: doc } of loadCases()) {
    assert.equal(doc.schema_version, 1);
    for (const probe of doc.probes) {
      assert.equal(probe.tool, "bash");
      assert.equal(forbidden.test(probe.command), false, `${slug}/${probe.call_id}: ${probe.command}`);
      assert.equal(probe.command.includes("bash -c"), false);
    }
  }
});

test("reference summaries produce ticket-2 diagnosis report shape", () => {
  for (const { case: doc } of loadCases()) {
    const calls = doc.probes.map((probe) => ({
      call_id: probe.call_id,
      tool_name: "bash",
      status: "completed",
      arguments_json: JSON.stringify({ command: probe.command }),
      result_json: JSON.stringify({
        ok: true,
        result: {
          exit_code: 0,
          output: { stdout: { text: `fixture output for ${probe.call_id}` } },
        },
      }),
    }));
    const report = buildDiagnosisReport(doc.expected.reference_summary, calls, doc.scenario_id);
    assert.equal(typeof report.conclusion, "string");
    assert.ok(report.evidence.length > 0);
    assert.equal(typeof report.recommended_next_step, "string");
    if (doc.expected.inconclusive) {
      assert.equal(report.inconclusive, true);
      assert.equal(report.conclusion, "无法确认");
    }
  }
});

test("build-report CLI matches in-process builder", () => {
  const doc = loadCases()[0].case;
  const payload = {
    summary: doc.expected.reference_summary,
    calls: doc.probes.map((probe) => ({
      call_id: probe.call_id,
      tool_name: "bash",
      status: "completed",
      arguments_json: JSON.stringify({ command: probe.command }),
      result_json: JSON.stringify({
        ok: true,
        result: { exit_code: 0, output: { stdout: { text: "ok" } } },
      }),
    })),
    scenario_id: doc.scenario_id,
  };
  const inline = buildDiagnosisReport(payload.summary, payload.calls, payload.scenario_id);
  const tsxCli = join(repoRoot, "apps/server/node_modules/tsx/dist/cli.mjs");
  const proc = spawnSync(process.execPath, [tsxCli, join(repoRoot, "fixtures/diagnosis/build-report.ts"), "-"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: repoRoot,
  });
  assert.equal(proc.status, 0, proc.stderr);
  const cli = JSON.parse(proc.stdout) as typeof inline;
  assert.deepEqual(cli.conclusion, inline.conclusion);
  assert.equal(cli.inconclusive, inline.inconclusive);
});
