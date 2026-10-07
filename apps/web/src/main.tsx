import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Worker = {
  worker_id: string;
  online: number;
  reconciled: number;
  blocked: number;
  connection_epoch: number;
};
function App() {
  const [workers, setWorkers] = useState<Worker[]>([]),
    [password, setPassword] = useState(""),
    [loggedIn, setLoggedIn] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/workers");
        if (response.status === 401) {
          if (active) setLoggedIn(false);
          return;
        }
        if (!response.ok) throw new Error();
        const rows = await response.json();
        if (active) {
          setWorkers(rows);
          setLoggedIn(true);
          setError("");
        }
      } catch {
        if (active) setError("暂时无法获取机器状态");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [loggedIn]);
  async function login(event: React.FormEvent) {
    event.preventDefault();
    try {
      const r = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setPassword("");
      if (!r.ok) {
        setError("登录失败，请检查密码或稍后重试");
        return;
      }
      setError("");
      setLoggedIn(true);
    } catch {
      setError("无法连接主节点");
    }
  }
  return (
    <main>
      <header>
        <span>WORKER PLANE</span>
        <h1>机器连接</h1>
        <p>查看已注册机器的连接与核对状态</p>
      </header>
      {error && <p role="alert">{error}</p>}
      {!loggedIn ? (
        <form onSubmit={login}>
          <label htmlFor="password">管理员密码</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button>登录</button>
        </form>
      ) : (
        <section aria-label="机器列表">
          {workers.length === 0 ? (
            <p>还没有注册的机器。</p>
          ) : (
            workers.map((w) => (
              <article key={w.worker_id}>
                <h2>{w.worker_id}</h2>
                <p>
                  {w.online ? "在线" : "离线"} ·{" "}
                  {w.blocked
                    ? "需要核对"
                    : w.reconciled
                      ? "核对完成"
                      : "等待核对"}
                </p>
                <small>连接代次 {w.connection_epoch}</small>
              </article>
            ))
          )}
        </section>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
