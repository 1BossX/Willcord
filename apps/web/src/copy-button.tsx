import { useState } from "react";

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [status, setStatus] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("已复制");
      window.setTimeout(() => setStatus(""), 1600);
    } catch {
      setStatus("复制失败");
    }
  }
  return (
    <button type="button" className="secondary-button copy-inline-button" onClick={() => void copy()}>
      {status || label}
    </button>
  );
}
