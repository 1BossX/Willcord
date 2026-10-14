import { useEffect, useState } from "react";
import { caFileName, fingerprintCheckNote, trustGuides, trustLinkCommand } from "./ca-trust";
import { caPemPath, loadCaFingerprint } from "./install-command";
import { CopyButton } from "./copy-button";

export function CaTrustGuide() {
  const [fingerprint, setFingerprint] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    loadCaFingerprint(controller.signal).then(
      value => { if (!controller.signal.aborted) setFingerprint(value); },
      e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => controller.abort();
  }, []);
  const shown = error ? `无法读取指纹：${error}` : fingerprint || "正在读取指纹…";
  return (
    <section className="ca-trust" aria-labelledby="ca-trust-title">
      <h3 id="ca-trust-title">信任证书</h3>
      <p>首次打开控制台前，请在这台机器上信任主节点根证书，避免浏览器拦截 HTTPS。</p>
      <div className="ca-trust-actions">
        <a className="secondary-button" href={caPemPath} download={caFileName}>下载 ca.pem</a>
      </div>
      <div className="copy-row">
        <code className="copy-row-value">{shown}</code>
        {fingerprint && <CopyButton text={fingerprint} label="复制指纹" />}
      </div>
      <p className="ca-trust-note"><strong>{fingerprintCheckNote}</strong></p>
      {trustGuides().map(guide => (
        <details key={guide.id}>
          <summary>{guide.title}</summary>
          <ol>
            {guide.steps.map(step => <li key={step}>{step}</li>)}
          </ol>
          {guide.commands.map(item => (
            <div className="copy-row" key={item.command}>
              <span>{item.label}</span>
              <code className="copy-row-value">{item.command}</code>
              <CopyButton text={item.command} label="复制命令" />
            </div>
          ))}
        </details>
      ))}
      <div className="copy-row">
        <code className="copy-row-value">{trustLinkCommand}</code>
        <CopyButton text={trustLinkCommand} label="复制命令" />
      </div>
    </section>
  );
}
