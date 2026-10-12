#!/usr/bin/env -S node --import tsx
/** CLI: read JSON from argv[1] and print buildDiagnosisReport result. */
import { readFileSync } from "node:fs";
import { buildDiagnosisReport } from "../../apps/server/src/diagnosis-report.ts";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: build-report.ts <json-file|-");
  process.exit(1);
}
const raw = arg === "-" ? readFileSync(0, "utf8") : readFileSync(arg, "utf8");
const input = JSON.parse(raw) as {
  summary: string;
  calls: Parameters<typeof buildDiagnosisReport>[1];
  scenario_id: Parameters<typeof buildDiagnosisReport>[2];
};
const report = buildDiagnosisReport(input.summary, input.calls, input.scenario_id);
process.stdout.write(JSON.stringify(report));
