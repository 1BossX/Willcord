import { useEffect, useState } from "react";
import { request } from "./api";
import { diagnosisScenarios, type DiagnosisScenario } from "./diagnosis-scenarios";
import { blockerMessage } from "./install-blockers";
import { Icon } from "./icon";
import { modelUnbound } from "./model-errors";
import { openEnrollment, usePendingEnrollments } from "./enrollment";
import { openModelSettings } from "./model-settings";
import {
  activeSetupBlocker,
  setupReadyForDiagnosis,
  setupSteps,
  type SetupSnapshot,
  type WorkerSnapshot,
} from "./setup-journey";

export const START_FIRST_DIAGNOSIS = "willcord:start-first-diagnosis";

type ModelView = { has_key: boolean };

type Props = {
  workers: WorkerSnapshot[];
  onStartScenario: (scenario: DiagnosisScenario, workerId: string) => void;
};

export function SetupJourneyPanel({ workers, onStartScenario }: Props) {
  const pending = usePendingEnrollments();
  const [modelBound, setModelBound] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      request<ModelView>("/api/settings/model")
        .then((v) => {
          if (live) setModelBound(!modelUnbound(v));
        })
        .catch(() => {});
    void load();
    window.addEventListener("willcord:model-settings-changed", load);
    return () => {
      live = false;
      window.removeEventListener("willcord:model-settings-changed", load);
    };
  }, []);

  const snapshot: SetupSnapshot = { modelBound, pendingApprovals: pending, workers };
  const steps = setupSteps(snapshot);
  const ready = setupReadyForDiagnosis(snapshot);
  const blocker = activeSetupBlocker(snapshot);
  const schedulable = workers.find((w) => w.schedulable);

  if (ready && schedulable) {
    return (
      <section className="setup-journey is-ready" aria-labelledby="first-diagnosis-title">
        <div className="setup-journey-head">
          <span className="eyebrow">首次诊断</span>
          <h2 id="first-diagnosis-title">选择场景，开始第一次诊断</h2>
          <p className="muted">
            机器 <strong>{schedulable.worker_id.slice(0, 12)}…</strong> 已可执行。选一个场景后会创建会话并填入诊断任务。
          </p>
        </div>
        <div className="diagnosis-scenario-grid">
          {diagnosisScenarios.map((scenario) => (
            <button
              key={scenario.id}
              type="button"
              className="diagnosis-scenario-card"
              onClick={() => onStartScenario(scenario, schedulable.worker_id)}
            >
              <strong>{scenario.title}</strong>
              <span>{scenario.summary}</span>
              <Icon name="arrow" />
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="setup-journey" aria-labelledby="setup-journey-title">
      <div className="setup-journey-head">
        <span className="eyebrow">安装进度</span>
        <h2 id="setup-journey-title">走到第一次诊断之前，还差这些步骤</h2>
      </div>
      <ol className="setup-step-list">
        {steps.map((step) => (
          <li key={step.id} className={step.done ? "is-done" : "is-pending"}>
            <span className="setup-step-marker" aria-hidden="true">{step.done ? "✓" : "·"}</span>
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
      {blocker && (
        <div className="setup-blocker" role="alert">
          <strong>{blocker.title}</strong>
          <p>{blockerMessage(blocker)}</p>
          <div className="setup-blocker-actions">
            {blocker.id === "model" && (
              <button type="button" className="primary-button" onClick={openModelSettings}>
                绑定模型
              </button>
            )}
            {blocker.id === "worker" && pending > 0 && (
              <button type="button" className="primary-button" onClick={openEnrollment}>
                去批准 worker
              </button>
            )}
            {blocker.id === "worker" && pending === 0 && (
              <button type="button" className="primary-button" onClick={openEnrollment}>
                添加机器
              </button>
            )}
          </div>
        </div>
      )}
      {pending > 0 && !blocker && (
        <button type="button" className="primary-button" onClick={openEnrollment}>
          有 {pending} 台机器等待批准
        </button>
      )}
    </section>
  );
}
