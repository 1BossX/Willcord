// The model's view of bash output: head and tail of complete output, head and
// a hint for output that ran past what was kept. Live runs and rebuilt
// transcripts both go through toolOutput, so these cover both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL_VIEW_HEAD_BYTES, MODEL_VIEW_TAIL_BYTES, toolOutput, type ToolRecord } from "../src/execution.js";

const bash = (stdout: string, total = Buffer.byteLength(stdout)): ToolRecord => ({
  ok: true,
  result: { exit_code: 0, output: {
    stdout: { text: stdout, bytes_shown: Buffer.byteLength(stdout), bytes_total: total, truncated: Buffer.byteLength(stdout) < total, gap: false },
    stderr: { text: "warn\n", bytes_shown: 5, bytes_total: 5, truncated: false, gap: false },
  } },
});
const seen = (record: ToolRecord) => JSON.parse(toolOutput(record).content[0].text);

test("short output and results without output reach the model unchanged", () => {
  const small = bash("x".repeat(MODEL_VIEW_HEAD_BYTES + MODEL_VIEW_TAIL_BYTES));
  assert.deepEqual(seen(small), small.result);
  const read: ToolRecord = { ok: true, result: { text: "y".repeat(50000), total_chars: 50000 } };
  assert.deepEqual(seen(read), read.result);
});

test("complete long output shows its start and its end, the middle stated", () => {
  const text = `START${"a".repeat(30000)}${"b".repeat(30000)}END\n`;
  const record = bash(text);
  const before = structuredClone(record);
  const { stdout, stderr } = seen(record).output;
  assert.ok(stdout.text.startsWith("START"));
  assert.ok(stdout.text.endsWith(text.slice(-MODEL_VIEW_TAIL_BYTES)), "the tail is the real end");
  assert.match(stdout.text, /\[… \d+ bytes in the middle not shown …\]/);
  assert.equal(stdout.bytes_shown, MODEL_VIEW_HEAD_BYTES + MODEL_VIEW_TAIL_BYTES);
  assert.deepEqual([stdout.bytes_total, stdout.truncated], [text.length, true]);
  assert.deepEqual(stderr, record.result.output.stderr, "a short stream is untouched");
  assert.deepEqual(record, before, "the stored record is not changed");
  assert.deepEqual(toolOutput(record).details, record.result, "details keep the full kept output");
  assert.equal(toolOutput(record).content[0].text, toolOutput(structuredClone(record)).content[0].text, "same record, same view");
});

test("output cut at the kept limit shows only its head, with how to see more", () => {
  const kept = "z".repeat(64 * 1024);
  const { stdout } = seen(bash(kept, 200000)).output;
  const head = MODEL_VIEW_HEAD_BYTES + MODEL_VIEW_TAIL_BYTES;
  assert.ok(stdout.text.startsWith("z".repeat(head) + "\n[… output continues: "));
  assert.match(stdout.text, new RegExp(`${200000 - head} more bytes not shown`));
  assert.match(stdout.text, /tail -n 100/);
  assert.deepEqual([stdout.bytes_shown, stdout.bytes_total, stdout.truncated], [head, 200000, true]);
});

test("a cut never splits a UTF-8 character", () => {
  const { stdout } = seen(bash("汉".repeat(20000))).output;
  assert.ok(!stdout.text.includes("�"));
  const cut = seen(bash("汉".repeat(21845), 200000)).output.stdout;
  assert.ok(!cut.text.includes("�"));
});
