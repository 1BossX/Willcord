import { useEffect, useState } from "react";
import { caFileName, fingerprintCheckNote, trustGuides, trustLinkCommand } from "./ca-trust";
import { caPemPath, loadCaFingerprint } from "./install-command";

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
      <p>主节点使用内部证书。首次使用前，请在这台机器上信任根证书，否则浏览器会提示连接不安全。</p>
      <a className="secondary-button" href={caPemPath} download={caFileName}>下载 ca.pem</a>
      <p>根证书 SHA-256 指纹（与 ca.pem 来自同一次连接）：</p>
      <code>{shown}</code>
      <p><strong>{fingerprintCheckNote}</strong></p>
      {trustGuides().map(guide => (
        <details key={guide.id}>
          <summary>{guide.title}</summary>
          <ol>
            {guide.steps.map(step => <li key={step}>{step}</li>)}
          </ol>
          {guide.commands.map(item => (
            <div key={item.command}>
              <span>{item.label}</span>
              <code>{item.command}</code>
            </div>
          ))}
        </details>
      ))}
      <p>
        已装 willcord 命令的机器，把从已信任或独立渠道核对过的指纹填入下面的命令；它会重新取得根证书，核对指纹后导入：
      </p>
      <code>{trustLinkCommand}</code>
    </section>
  );
}
