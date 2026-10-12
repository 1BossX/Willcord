import assert from "node:assert/strict";
import test from "node:test";
import { buildDiagnosisReport, parseDiagnosisSections } from "../src/diagnosis-report.js";

test("parseDiagnosisSections reads the three headings", () => {
  const text = `## 结论
容器退出码 1。

## 证据
调用 \`c1\` 的 docker logs 显示 Error。

## 建议的下一步
检查镜像环境变量。`;
  const parts = parseDiagnosisSections(text);
  assert.match(parts.conclusion, /退出码/);
  assert.match(parts.evidenceText, /c1/);
  assert.match(parts.recommended_next_step, /环境变量/);
});

test("buildDiagnosisReport forces inconclusive without inspection calls", () => {
  const report = buildDiagnosisReport(
    "## 结论\n确定是磁盘满了。\n\n## 证据\n猜测。\n\n## 建议的下一步\n扩容。",
    [],
    "disk-usage",
  );
  assert.equal(report.conclusion, "无法确认");
  assert.equal(report.inconclusive, true);
});

test("buildDiagnosisReport keeps a cited definite conclusion", () => {
  const calls = [
    {
      call_id: "bash-1",
      tool_name: "bash",
      status: "completed",
      arguments_json: JSON.stringify({ command: "docker ps" }),
      result_json: JSON.stringify({
        ok: true,
        result: { exit_code: 0, output: { stdout: { text: "badcontainer Exited (1)" } } },
      }),
    },
  ];
  const summary = `## 结论
容器 badcontainer 因退出码 1 停止。

## 证据
\`bash-1\` 的 docker ps 输出显示 Exited (1)。

## 建议的下一步
查看 docker logs badcontainer。`;
  const report = buildDiagnosisReport(summary, calls, "docker-service");
  assert.equal(report.inconclusive, false);
  assert.match(report.conclusion, /badcontainer/);
  assert.equal(report.evidence[0]?.call_id, "bash-1");
});

test("failed tool results do not count as inspection evidence", () => {
  const calls = [
    {
      call_id: "c1",
      tool_name: "bash",
      status: "completed",
      arguments_json: JSON.stringify({ command: "df -h" }),
      result_json: JSON.stringify({ ok: false, result: { error: "command failed" } }),
    },
  ];
  const summary = `## 结论
磁盘已满导致写入失败。

## 证据
\`c1\` 显示根分区 100%。

## 建议的下一步
清理 /var/log。`;
  const report = buildDiagnosisReport(summary, calls, "disk-usage");
  assert.equal(report.inconclusive, true);
  assert.equal(report.conclusion, "无法确认");
  assert.equal(report.evidence.length, 0);
  assert.ok(!JSON.stringify(report.evidence).includes("command failed"));
});
