import type { DiagnosisScenarioId } from "./diagnosis-scenarios";

type DiagnosisSession = {
  kind: string;
  worker_id: string;
  execution_mode?: "diagnosis" | null;
  diagnosis_scenario?: DiagnosisScenarioId | null;
};

/** Reuse an empty diagnosis session only when it is for the same scenario. */
export function canReuseDiagnosisSession(
  session: DiagnosisSession | null | undefined,
  workerId: string,
  scenarioId: DiagnosisScenarioId,
  hasMessages: boolean,
  hasJobs: boolean,
): boolean {
  return Boolean(
    session?.kind === "worker" &&
      session.worker_id === workerId &&
      session.execution_mode === "diagnosis" &&
      session.diagnosis_scenario === scenarioId &&
      !hasMessages &&
      !hasJobs,
  );
}
