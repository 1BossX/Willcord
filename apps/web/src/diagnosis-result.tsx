import React from "react";
import { MarkdownMessage } from "./main-markdown";

export type DiagnosisEvidenceItem = {
  call_id: string;
  tool_name: string;
  label: string;
  excerpt: string;
};

export type DiagnosisReport = {
  scenario_id: string | null;
  conclusion: string;
  evidence: DiagnosisEvidenceItem[];
  recommended_next_step: string;
  inconclusive: boolean;
};

export function DiagnosisResultPanel({
  report,
  onNewDiagnosis,
}: {
  report: DiagnosisReport;
  onNewDiagnosis?: () => void;
}) {
  return (
    <section className="diagnosis-result" aria-label="诊断结果">
      <h3 className="diagnosis-result-heading">诊断结果</h3>
      <div className="diagnosis-result-block">
        <h4>结论</h4>
        <div className={report.inconclusive ? "diagnosis-inconclusive" : undefined}>
          <MarkdownMessage value={report.conclusion} />
        </div>
      </div>
      <div className="diagnosis-result-block">
        <h4>证据</h4>
        {report.evidence.length ? (
          <ul className="diagnosis-evidence-list">
            {report.evidence.map((item) => (
              <li key={item.call_id}>
                <span className="diagnosis-evidence-meta">
                  <strong>{item.tool_name}</strong> · {item.label}
                </span>
                <span className="diagnosis-call-id" title={`调用 ID：${item.call_id}`}>
                  ID {item.call_id.slice(0, 8)}
                </span>
                <pre>{item.excerpt}</pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-copy">本次没有可引用的只读检查输出。</p>
        )}
      </div>
      <div className="diagnosis-result-block">
        <h4>建议的下一步</h4>
        <div className="diagnosis-next-step">
          <MarkdownMessage value={report.recommended_next_step} />
        </div>
      </div>
      {onNewDiagnosis && (
        <div className="diagnosis-result-actions">
          <button type="button" className="secondary-button" onClick={onNewDiagnosis}>
            新建诊断会话
          </button>
        </div>
      )}
    </section>
  );
}
