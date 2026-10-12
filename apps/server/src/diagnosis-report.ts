import type { DiagnosisScenarioId } from "./diagnosis-scenarios.js";

export type DiagnosisEvidenceItem = {
  call_id: string;
  tool_name: string;
  label: string;
  excerpt: string;
};

export type DiagnosisReport = {
  scenario_id: DiagnosisScenarioId | null;
  conclusion: string;
  evidence: DiagnosisEvidenceItem[];
  recommended_next_step: string;
  /** True when the host forced 「无法确认」 because evidence was insufficient. */
  inconclusive: boolean;
};

type CallInput = {
  call_id: string;
  tool_name: string;
  status: string;
  arguments_json?: string;
  result_json: string | null;
};

const INCONCLUSIVE = "无法确认";

const section = (text: string, name: string) => {
  const re = new RegExp(`^##\\s*${name}\\s*$`, "im");
  const match = re.exec(text);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
};

export function parseDiagnosisSections(summary: string) {
  return {
    conclusion: section(summary, "结论"),
    evidenceText: section(summary, "证据"),
    recommended_next_step: section(summary, "建议的下一步"),
  };
}

function callLabel(tool: string, args: Record<string, unknown> | undefined) {
  if (tool === "bash" && typeof args?.command === "string") return args.command;
  if (tool === "read" && typeof args?.path === "string") return args.path;
  return tool;
}

function excerptFromResult(tool: string, record: { ok: boolean; result?: any }): string {
  if (!record.ok) return record.result?.error ? String(record.result.error) : "工具未成功执行";
  const r = record.result ?? {};
  if (tool === "read" && typeof r.text === "string") return r.text.slice(0, 400);
  if (tool === "bash") {
    const stdout = r.output?.stdout?.text ?? r.stdout;
    if (typeof stdout === "string" && stdout) return stdout.slice(0, 600);
    if (typeof r.stderr === "string" && r.stderr) return r.stderr.slice(0, 400);
    if (typeof r.exit_code === "number") return `退出码 ${r.exit_code}`;
  }
  return JSON.stringify(r).slice(0, 300);
}

function citedCallIds(text: string, known: Set<string>) {
  const cited = new Set<string>();
  for (const id of known) {
    if (text.includes(id)) cited.add(id);
  }
  return cited;
}

function modelClaimsInconclusive(conclusion: string) {
  return /无法确认/.test(conclusion);
}

function modelClaimsDefiniteCause(conclusion: string) {
  if (!conclusion || modelClaimsInconclusive(conclusion)) return false;
  return conclusion.length > 0;
}

/**
 * Build the structured diagnosis result from the model summary and committed calls.
 * When inspection evidence is missing, conclusion is forced to 「无法确认」.
 */
export function buildDiagnosisReport(
  summary: string,
  calls: CallInput[],
  scenarioId: DiagnosisScenarioId | null,
): DiagnosisReport {
  const parsed = parseDiagnosisSections(summary);
  const inspection = calls.filter(
    (c) =>
      c.status === "completed" &&
      (c.tool_name === "bash" || c.tool_name === "read") &&
      c.result_json,
  );
  const evidenceItems: DiagnosisEvidenceItem[] = [];
  for (const c of inspection) {
    const args = c.arguments_json ? JSON.parse(c.arguments_json) as Record<string, unknown> : {};
    const record = JSON.parse(c.result_json!) as { ok: boolean; result?: unknown };
    evidenceItems.push({
      call_id: c.call_id,
      tool_name: c.tool_name,
      label: callLabel(c.tool_name, args),
      excerpt: excerptFromResult(c.tool_name, record),
    });
  }

  const knownIds = new Set(evidenceItems.map((e) => e.call_id));
  const cited = citedCallIds(parsed.evidenceText, knownIds);
  const hasInspection = evidenceItems.some((e) => e.excerpt && !e.excerpt.startsWith("工具未成功"));
  let inconclusive =
    !hasInspection ||
    (modelClaimsDefiniteCause(parsed.conclusion) && cited.size === 0);

  if (modelClaimsInconclusive(parsed.conclusion)) inconclusive = true;

  const conclusion = inconclusive ? INCONCLUSIVE : parsed.conclusion || INCONCLUSIVE;
  if (!inconclusive && !parsed.conclusion) inconclusive = true;

  const evidence =
    inconclusive && cited.size === 0
      ? evidenceItems.slice(0, 8)
      : evidenceItems.filter((e) => cited.has(e.call_id) || cited.size === 0).slice(0, 8);

  return {
    scenario_id: scenarioId,
    conclusion,
    evidence: evidence.length ? evidence : evidenceItems.slice(0, 8),
    recommended_next_step: parsed.recommended_next_step || "根据证据继续排查，或补充只读检查后重试。",
    inconclusive,
  };
}
