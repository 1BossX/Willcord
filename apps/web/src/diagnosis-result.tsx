import React from "react";

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

export function DiagnosisResultPanel({ report }: { report: DiagnosisReport }) {
  return (
    <section className="diagnosis-result" aria-label="诊断结果">
      <h3 className="diagnosis-result-heading">诊断结果</h3>
      <div className="diagnosis-result-block">
        <h4>结论</h4>
        <p className={report.inconclusive ? "diagnosis-inconclusive" : undefined}>{report.conclusion}</p>
      </div>
      <div className="diagnosis-result-block">
        <h4>证据</h4>
        {report.evidence.length ? (
          <ul className="diagnosis-evidence-list">
            {report.evidence.map((item) => (
              <li key={item.call_id}>
                <code className="diagnosis-call-id">{item.call_id}</code>
                <span className="diagnosis-evidence-meta">{item.tool_name} · {item.label}</span>
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
        <p>{report.recommended_next_step}</p>
      </div>
    </section>
  );
}
