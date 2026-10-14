import type { DiagnosisScenario } from "./diagnosis-scenarios.ts";
import { diagnosisScenarios } from "./diagnosis-scenarios.ts";

export type SessionLabelInput = {
  title: string | null;
  workspace_id: string;
  execution_mode?: "diagnosis" | null;
  diagnosis_scenario?: DiagnosisScenario["id"] | null;
  parent_job_id?: string | null;
};

function scenarioTitle(id: DiagnosisScenario["id"] | null | undefined) {
  return diagnosisScenarios.find((s) => s.id === id)?.title;
}

/** Sidebar and header label: prefer explicit title, then diagnosis scenario name, then workspace. */
export function sessionDisplayTitle(session: SessionLabelInput): string {
  if (session.title?.trim()) return session.title.trim();
  if (session.execution_mode === "diagnosis") {
    const fromScenario = scenarioTitle(session.diagnosis_scenario ?? null);
    if (fromScenario) return fromScenario;
    return "诊断会话";
  }
  return session.workspace_id;
}

export function sessionDisplaySubtitle(session: SessionLabelInput): string {
  const parts: string[] = [];
  if (session.parent_job_id) parts.push("委派");
  if (session.execution_mode === "diagnosis" && session.title?.trim()) {
    const fromScenario = scenarioTitle(session.diagnosis_scenario ?? null);
    const title = session.title.trim();
    if (fromScenario && fromScenario !== title) parts.push(fromScenario);
  }
  return parts.join(" · ");
}
