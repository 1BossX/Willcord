// Browser walkthrough environment (not a test): an in-process main node with a
// scripted model, two real Rust workers (w, v), and an HTTP front end on
// WALK_PORT that serves apps/web/dist and forwards /api and /auth to the main
// node, rewriting Origin the way the production reverse proxy presents it.
// Run: node --import tsx apps/server/test/support/walkthrough.ts
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize } from "node:path";
import type { ScriptStep } from "../../src/execution.js";
import { origin, startScenario } from "./main-node.js";
import { repoRoot } from "./worker-harness.js";

const port = Number(process.env.WALK_PORT ?? 8105);
const bash = (id: string, command: string, answer: string): ScriptStep[] => [{ tool: "bash", arguments: { command }, id }, { text: answer, tokens_per_second: 12 }];
const delegate = (id: string, args: Record<string, unknown>) => ({ tool: "delegate" as const, arguments: args, id });
let n = 0;
const fresh = (steps: ScriptStep[]) => steps.map((s) => ("tool" in s ? { ...s, id: `${s.id}-${++n}` } : "calls" in s ? { ...s, calls: s.calls.map((c) => ({ ...c, id: `${c.id}-${++n}` })) } : s));
const scripts: Record<string, () => ScriptStep[]> = {
  "跑测试": () => bash("test", "echo test >> marker.log; for i in $(seq 1 8); do echo \"check $i ok\"; sleep 1; done", "测试通过：8 项检查全部成功，结果已写入 marker.log。"),
  "长任务": () => bash("long", "echo long >> marker.log; sleep 120", "长任务结束。"),
  "慢慢回答": () => [{ text: "这是一段逐字生成的回答，用来观察草稿在提交前的样子。它会持续几秒钟，你可以在生成过程中取消任务，看草稿如何被标记为中断而不是当作回答。", tokens_per_second: 1 }],
  "在 w 上跑测试，通过后在 v 上写说明": () => [
    { calls: [
      delegate("m-test", { worker_id: "w", prompt: "test-ok", delegation_key: "test", verify: "grep -q test-end marker.log" }),
      delegate("m-doc", { worker_id: "v", prompt: "doc", delegation_key: "doc", depends_on: ["test"] }),
    ] },
    { text: "w 上的测试已通过验证，v 上的说明已写好。", tokens_per_second: 12 },
  ],
  "测试失败的情况": () => [
    { calls: [
      delegate("f-test", { worker_id: "w", prompt: "test-claims-ok", delegation_key: "test", verify: "grep -q never-written marker.log" }),
      delegate("f-doc", { worker_id: "v", prompt: "doc", delegation_key: "doc", depends_on: ["test"] }),
    ] },
    { text: "子任务已结束，请查看各自结果。", tokens_per_second: 12 },
  ],
  "test-ok": () => bash("ok", "echo test-start >> marker.log; sleep 3; echo test-end >> marker.log", "测试通过。"),
  "test-claims-ok": () => bash("claims", "echo test-start >> marker.log", "测试应该通过了。"),
  doc: () => bash("doc", "echo doc >> marker.log; ls > NOTES.txt", "说明已写入 NOTES.txt。"),
};

const s = await startScenario({ workers: ["w", "v"], scripts: new Proxy({}, { get: (_t, key: string) => scripts[key] ? fresh(scripts[key]()) : [{ text: `（走查脚本里没有这条消息：${key}）` }] }) as any });
s.startWorker({ id: "w" }); s.startWorker({ id: "v" });
await s.ready("w"); await s.ready("v");

const dist = join(repoRoot, "apps/web/dist");
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/api/") || url.startsWith("/auth/")) {
    const upstream = http.request({ host: "127.0.0.1", port: s.main.port, path: url, method: req.method, headers: { ...req.headers, host: "localhost:8443", ...(req.headers.origin ? { origin } : {}) } }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
    return;
  }
  const file = normalize(join(dist, url.split("?")[0]));
  const target = file.startsWith(dist) && existsSync(file) && statSync(file).isFile() ? file : join(dist, "index.html");
  res.writeHead(200, { "content-type": types[extname(target)] ?? "application/octet-stream" });
  createReadStream(target).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`walkthrough ready http://localhost:${port} main=${s.main.port} dir=${s.dir}`));
