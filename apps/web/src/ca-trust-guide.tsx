import { useEffect, useState } from "react";
import { caFileName, trustGuides } from "./ca-trust";
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
      <p>
        根证书 SHA-256 指纹。<strong>请与管理员渠道（工单、内部通知或当面）拿到的指纹逐位核对；不一致请勿信任，并联系管理员。</strong>
      </p>
      <code>{shown}</code>
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
        已装 willcord 命令的机器，可运行下面的命令，它会重新取得根证书并核对指纹后导入：
      </p>
      <code>{`willcord trust-ca 'https://<主节点地址>#sha256=${fingerprint || "<上方指纹>"}'`}</code>
    </section>
  );
}
