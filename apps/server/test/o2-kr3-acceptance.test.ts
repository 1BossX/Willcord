// O2-KR3 registry: four fault types are covered by the P3–P6 fault programs and
// lock tests cited in docs/dev/acceptance/o2-kr3-four-fault-types.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const doc = readFileSync(
  join(import.meta.dirname, "../../../docs/dev/acceptance/o2-kr3-four-fault-types.md"),
  "utf8",
);

test("O2-KR3 acceptance doc maps four fault types to automated tests", () => {
  for (const label of ["断线", "主节点重启", "取消", "结果丢失"]) assert.ok(doc.includes(label), label);
  for (const file of [
    "p3-faults.test.ts",
    "p3-main-process.test.ts",
    "p4-faults.test.ts",
    "p4-control.test.ts",
    "p6-faults.test.ts",
    "lock.test.ts",
  ]) assert.ok(doc.includes(file), file);
  assert.match(doc, /不盲目重跑/);
  assert.match(doc, /needs_attention/);
});
