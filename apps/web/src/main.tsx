import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { ApiError, request } from "./api";
import { AttentionPanel, BudgetRows, CancelButton, LogViewer, RetryButton, type JobControl } from "./control";
import "./style.css";

type Worker = {
  worker_id: string;
  online: number;
  reconciled: number;
  blocked: number;
  active_job_id: string | null;
};
type Workspace = {
  workspace_id: string;
  repo_id: string;
  path: string;
  is_default: number;
  config_version: number;
};
type Session = {
  session_id: string;
  kind: "worker" | "main";
  worker_id: string;
  workspace_id: string;
  repo_id: string;
  path: string;
  created_at: number;
  title: string | null;
  /** Set on a child session created by a Main Agent delegation. */
  parent_job_id?: string | null;
  delegation_id?: string | null;
};
type Job = JobControl & {
  job_id: string;
  state: string;
  input_text: string;
  created_at: number;
  started_at: number | null;
  queue_position: number | null;
  wait_until: number | null;
};
type Message = { message_id: string; job_id: string; content_json: string };
type ToolContent = {
  error?: string;
  text?: string;
  total_chars?: number;
  truncated?: boolean;
  bytes?: number;
  sha256?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number | null;
  signal?: number | null;
  termination?: "exited" | "cancelled" | "timeout";
  output?: Partial<Record<"stdout" | "stderr", StreamOutput>>;
  /** delegate results. */
  job_id?: string;
  session_id?: string;
  worker_id?: string;
  delegation_id?: string;
  state?: string;
  duplicate?: boolean;
  depends_on?: string[];
  verify?: string | null;
  waiting_for_dependencies?: boolean;
  workers?: Array<{ worker_id: string; ready: boolean; busy: boolean; queued_jobs: number }>;
};
/** What the main node assembled from stored chunks for the model. */
type StreamOutput = {
  text: string;
  bytes_shown: number;
  bytes_total: number;
  truncated: boolean;
  gap: boolean;
};
type Content = {
  role: string;
  tool?: string;
  call_id?: string;
  ok?: boolean;
  arguments?: { path?: string; command?: string; prompt?: string; job_id?: string };
  content: string | { type?: string; text?: string }[] | ToolContent;
};
type IconName =
  | "plane"
  | "grid"
  | "server"
  | "chat"
  | "plus"
  | "arrow"
  | "chevron"
  | "check"
  | "clock"
  | "alert"
  | "terminal"
  | "file"
  | "write"
  | "lock"
  | "close"
  | "menu"
  | "logout";
const paths: Record<IconName, React.ReactNode> = {
  plane: (
    <>
      <path d="m3 10 18-7-7 18-3-8-8-3Z" />
      <path d="m11 13 10-10" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01M17 7h1M17 17h1" />
    </>
  ),
  chat: <path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 19 0Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  alert: (
    <>
      <path d="m12 3 10 18H2L12 3Z" />
      <path d="M12 9v4m0 4h.01" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
      <path d="M14 3v6h6m-12 4h8m-8 4h5" />
    </>
  ),
  write: (
    <>
      <path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  logout: (
    <>
      <path d="M10 3H5v18h5m3-9h8m-3-3 3 3-3 3" />
    </>
  ),
};
function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
const jobLabels: Record<string, string> = {
  queued: "排队中",
  waiting_worker: "等待上线",
  running: "执行中",
  waiting_children: "等待子任务",
  cancel_requested: "正在停止",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  needs_attention: "需要核对",
};
const activeStates = new Set([
  "running",
  "waiting_children",
  "cancel_requested",
]);
const queuedStates = new Set(["queued", "waiting_worker"]);
function time(value: number | null, full = false) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        ...(full ? { month: "short", day: "numeric" } : {}),
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
}
function workerStatus(worker: Worker) {
  if (worker.blocked) return { label: "需要核对", tone: "danger" };
  if (worker.active_job_id) return { label: "忙碌", tone: "active" };
  if (!worker.online) return { label: "未就绪", tone: "muted" };
  if (!worker.reconciled) return { label: "等待对账", tone: "warning" };
  return { label: "空闲", tone: "success" };
}
function Status({ state }: { state: string }) {
  return (
    <span className={`status status-${state}`}>
      <span className="status-dot" />
      {jobLabels[state] ?? state}
    </span>
  );
}
function parseMessage(message: Message): Content {
  try {
    return JSON.parse(message.content_json) as Content;
  } catch {
    return { role: "assistant", content: message.content_json };
  }
}
function toolFailure(value: Content) {
  const result =
    value.content &&
    typeof value.content === "object" &&
    !Array.isArray(value.content)
      ? (value.content as ToolContent)
      : {};
  if (value.role !== "tool") return "";
  if (value.ok === false || result.error) return result.error ?? "工具执行失败";
  if (
    (value.tool === "bash" || result.exit_code !== undefined) &&
    typeof result.exit_code === "number" &&
    result.exit_code !== 0
  )
    return `命令退出码 ${result.exit_code}`;
  return "";
}
function messageText(content: Content) {
  if (typeof content.content === "string") return content.content;
  if (Array.isArray(content.content))
    return content.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
  return "";
}

type MarkdownToken = {
  type: string;
  raw?: string;
  text?: string;
  lang?: string;
  href?: string;
  title?: string;
  depth?: number;
  ordered?: boolean;
  start?: number;
  checked?: boolean;
  task?: boolean;
  align?: ("left" | "center" | "right" | null)[];
  tokens?: MarkdownToken[];
  items?: MarkdownToken[];
  header?: MarkdownToken[];
  rows?: MarkdownToken[][];
};

function safeLink(href: string | undefined) {
  if (!href) return "";
  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : "";
  } catch {
    return "";
  }
}

function InlineMarkdown({ tokens = [] }: { tokens?: MarkdownToken[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        const key = `${token.type}-${index}`;
        const children = token.tokens ?? [];
        switch (token.type) {
          case "strong":
            return (
              <strong key={key}>
                <InlineMarkdown tokens={children} />
              </strong>
            );
          case "em":
            return (
              <em key={key}>
                <InlineMarkdown tokens={children} />
              </em>
            );
          case "del":
            return (
              <del key={key}>
                <InlineMarkdown tokens={children} />
              </del>
            );
          case "codespan":
            return <code key={key}>{token.text}</code>;
          case "br":
            return <br key={key} />;
          case "link": {
            const href = safeLink(token.href);
            return href ? (
              <a
                key={key}
                href={href}
                title={token.title}
                target="_blank"
                rel="noreferrer noopener"
              >
                <InlineMarkdown tokens={children} />
              </a>
            ) : (
              <InlineMarkdown key={key} tokens={children} />
            );
          }
          case "image":
            return <span key={key}>{token.text ?? ""}</span>;
          case "html":
            return <span key={key}>{token.raw ?? token.text ?? ""}</span>;
          case "text":
            return children.length ? (
              <React.Fragment key={key}>
                <InlineMarkdown tokens={children} />
              </React.Fragment>
            ) : (
              <React.Fragment key={key}>{token.text ?? ""}</React.Fragment>
            );
          default:
            return (
              <React.Fragment key={key}>
                {token.text ?? token.raw ?? ""}
              </React.Fragment>
            );
        }
      })}
    </>
  );
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="markdown-code">
      <div className="markdown-code-bar">
        <span>{language || "代码"}</span>
        <button type="button" onClick={() => void copy()} aria-label="复制代码">
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function MarkdownBlocks({ tokens = [] }: { tokens?: MarkdownToken[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        const key = `${token.type}-${index}`;
        const inline = <InlineMarkdown tokens={token.tokens ?? []} />;
        switch (token.type) {
          case "heading": {
            const level = Math.min(6, Math.max(1, token.depth ?? 1));
            return React.createElement(`h${level}`, { key }, inline);
          }
          case "paragraph":
          case "text":
            return <p key={key}>{inline}</p>;
          case "list": {
            const items = (token.items ?? []).map((item, itemIndex) => (
              <li key={itemIndex}>
                {item.task && (
                  <input
                    type="checkbox"
                    checked={Boolean(item.checked)}
                    readOnly
                    aria-label="任务项"
                  />
                )}
                <MarkdownBlocks tokens={item.tokens ?? []} />
              </li>
            ));
            return token.ordered ? (
              <ol key={key} start={token.start}>
                {items}
              </ol>
            ) : (
              <ul key={key}>{items}</ul>
            );
          }
          case "blockquote":
            return (
              <blockquote key={key}>
                <MarkdownBlocks tokens={token.tokens} />
              </blockquote>
            );
          case "code":
            return (
              <CodeBlock
                key={key}
                code={token.text ?? ""}
                language={token.lang?.split(/\s+/, 1)[0]}
              />
            );
          case "table":
            return (
              <div className="markdown-table-wrap" key={key}>
                <table>
                  <thead>
                    <tr>
                      {(token.header ?? []).map((cell, cellIndex) => (
                        <th
                          key={cellIndex}
                          style={{ textAlign: token.align?.[cellIndex] ?? undefined }}
                        >
                          <InlineMarkdown tokens={cell.tokens} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(token.rows ?? []).map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            style={{ textAlign: token.align?.[cellIndex] ?? undefined }}
                          >
                            <InlineMarkdown tokens={cell.tokens} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "hr":
            return <hr key={key} />;
          case "space":
            return null;
          case "html":
            return <p key={key}>{token.raw ?? token.text ?? ""}</p>;
          default:
            return <p key={key}>{inline}</p>;
        }
      })}
    </>
  );
}

function MarkdownMessage({ value }: { value: string }) {
  const tokens = marked.lexer(value) as MarkdownToken[];
  return <MarkdownBlocks tokens={tokens} />;
}

function ToolCard({ value, jobId, onOpenSession }: { value: Content; jobId: string; onOpenSession?: (sessionId: string) => void }) {
  const [showLog, setShowLog] = useState(false);
  const result = (
    value.content &&
    typeof value.content === "object" &&
    !Array.isArray(value.content)
      ? value.content
      : {}
  ) as ToolContent;
  const tool =
    value.tool ??
    (result.exit_code !== undefined
      ? "bash"
      : result.bytes !== undefined
        ? "write"
        : result.text !== undefined
          ? "read"
          : "tool");
  const nonzeroExit =
    tool === "bash" &&
    typeof result.exit_code === "number" &&
    result.exit_code !== 0;
  const streamText = (stream: "stdout" | "stderr") =>
    result.output?.[stream]?.text ?? result[stream] ?? "";
  const outputCut = ["stdout", "stderr"].some(
    (s) => result.output?.[s as "stdout" | "stderr"]?.truncated,
  );
  const outputGap = ["stdout", "stderr"].some(
    (s) => result.output?.[s as "stdout" | "stderr"]?.gap,
  );
  const stopped =
    result.termination === "cancelled"
      ? "已取消"
      : result.termination === "timeout"
        ? "已超时停止"
        : "";
  const failed = value.ok === false || Boolean(result.error) || nonzeroExit;
  const titles: Record<string, string> = {
    read: "读取文件",
    write: "写入文件",
    bash: "运行命令",
    delegate: "委派任务",
    list_workers: "查看机器",
    get_job: "查看任务",
    tool: "工具结果",
  };
  const summary = failed
    ? (result.error ?? (nonzeroExit ? `命令失败 · 退出码 ${result.exit_code}` : "工具执行失败"))
    : tool === "read"
      ? `${result.total_chars ?? 0} 字符${result.truncated ? " · 已截断" : ""}`
      : tool === "write"
        ? `${(result.bytes ?? 0).toLocaleString()} 字节`
        : tool === "delegate"
          ? `${result.worker_id ?? "机器"} · ${result.duplicate ? "沿用已有委派" : result.waiting_for_dependencies ? "已委派，排在前置任务之后" : "已委派"}`
        : tool === "list_workers"
          ? `${result.workers?.length ?? 0} 台机器`
        : tool === "bash"
          ? `${stopped ? `${stopped} · 信号 ${result.signal ?? "未知"}` : `退出码 ${result.exit_code ?? "未知"}`}${result.truncated || outputCut ? " · 输出已截断" : ""}`
          : "查看结果";
  return (
    <details className={`tool-card ${failed ? "tool-failed" : ""}`}>
      <summary>
        <span className="tool-icon">
          <Icon
            name={
              tool === "bash" ? "terminal" : tool === "write" ? "write" : "file"
            }
          />
        </span>
        <span className="tool-title">
          <strong>{titles[tool] ?? titles.tool}</strong>
          <span>
            {tool === "bash"
              ? (value.arguments?.command ?? "远程命令")
              : tool === "delegate"
                ? (value.arguments?.prompt ?? "委派")
                : tool === "get_job"
                  ? (value.arguments?.job_id ?? "任务")
                  : tool === "list_workers"
                    ? "全部机器"
                    : (value.arguments?.path ?? "远程工作目录")}
          </span>
        </span>
        <span
          className={`tool-outcome ${failed ? "danger-text" : nonzeroExit ? "exit-warning" : ""}`}
        >
          {summary}
        </span>
        <Icon name="chevron" className="detail-chevron" />
      </summary>
      <div className="tool-body">
        {failed && <p className="danger-text">{result.error ?? (nonzeroExit ? `命令执行失败，退出码 ${result.exit_code}。` : "执行失败，请查看工具结果。")}</p>}
        {(!failed || nonzeroExit) && (
          <>
            {tool === "read" && <pre>{result.text || "文件内容为空。"}</pre>}
            {tool === "write" && (
              <p>
                文件已原子替换，共写入 {(result.bytes ?? 0).toLocaleString()}{" "}
                字节。
              </p>
            )}
            {tool === "bash" && (
              <>
                <div className="stream-label">STDOUT</div>
                <pre>{streamText("stdout") || "无标准输出"}</pre>
                {streamText("stderr") && (
                  <>
                    <div className="stream-label">STDERR</div>
                    <pre>{streamText("stderr")}</pre>
                  </>
                )}
              </>
            )}
            {tool === "delegate" && (
              <dl className="delegation-facts">
                <dt>目标</dt><dd>{result.worker_id} / {String((result as Record<string, unknown>).workspace_id ?? "默认工作目录")}</dd>
                <dt>委派 ID</dt><dd>{result.delegation_id}</dd>
                {result.depends_on?.length ? (<><dt>前置任务</dt><dd>{result.depends_on.join("、")}</dd></>) : null}
                {result.verify ? (<><dt>验证命令</dt><dd><code>{result.verify}</code></dd></>) : null}
              </dl>
            )}
            {tool === "delegate" && result.session_id && onOpenSession && (
              <button type="button" className="secondary-button" onClick={() => onOpenSession(result.session_id!)}>打开子会话</button>
            )}
            {(tool === "tool" || tool === "list_workers" || tool === "get_job") && <pre>{JSON.stringify(result, null, 2)}</pre>}
          </>
        )}
        {(result.truncated || outputCut) && (
          <p className="output-notice">
            此处展示的输出已截断
            {(["stdout", "stderr"] as const)
              .filter((s) => result.output?.[s]?.truncated)
              .map(
                (s) =>
                  `，${s} 显示 ${result.output![s]!.bytes_shown.toLocaleString()} / ${result.output![s]!.bytes_total.toLocaleString()} 字节`,
              )
              .join("")}
            。
          </p>
        )}
        {outputGap && (
          <p className="output-notice">
            部分输出已无法从机器取回，显示内容存在缺口。
          </p>
        )}
        {result.sha256 && (
          <details className="technical-detail">
            <summary>文件校验值</summary>
            <code>{result.sha256}</code>
          </details>
        )}
        {tool === "bash" && result.output && value.call_id && (
          showLog
            ? <LogViewer jobId={jobId} callId={value.call_id} />
            : <button type="button" className="secondary-button" onClick={() => setShowLog(true)}>查看完整日志</button>
        )}
        {value.call_id && <span className="call-id">调用 {value.call_id}</span>}
      </div>
    </details>
  );
}
function ChatMessage({ message, agent = "Worker Agent", onOpenSession }: { message: Message; agent?: string; onOpenSession?: (sessionId: string) => void }) {
  const value = parseMessage(message);
  if (value.role === "tool") return <ToolCard value={value} jobId={message.job_id} onOpenSession={onOpenSession} />;
  return (
    <div
      className={`chat-message ${value.role === "user" ? "from-user" : "from-agent"}`}
    >
      <span className="message-avatar">
        {value.role === "user" ? "你" : <Icon name="plane" />}
      </span>
      <div className="message-body">
        <div className="message-author">
          {value.role === "user" ? "你" : agent}
        </div>
        <div className="message-copy">
          {value.role === "user" ? messageText(value) : <MarkdownMessage value={messageText(value)} />}
        </div>
      </div>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState<"checking" | "logged-out" | "logged-in">(
    "checking",
  );
  const [workers, setWorkers] = useState<Worker[]>([]),
    [sessions, setSessions] = useState<Session[]>([]);
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null),
    [sessionId, setSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null),
    [editingTitle, setEditingTitle] = useState("");
  const [messages, setMessages] = useState<Message[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("worker-plane-drafts") ?? "{}",
      );
      return saved && typeof saved === "object" && !Array.isArray(saved)
        ? saved
        : {};
    } catch {
      return {};
    }
  });
  const text = sessionId ? drafts[sessionId] ?? "" : "";
  const setText = (value: string) => {
    if (!sessionId) return;
    setDrafts((current) => ({ ...current, [sessionId]: value }));
  };
  const [password, setPassword] = useState(""),
    [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false),
    [loggingIn, setLoggingIn] = useState(false),
    [loadingConversation, setLoadingConversation] = useState(false);
  const [modalOpen, setModalOpen] = useState(false),
    [modalWorker, setModalWorker] = useState(""),
    [modalWorkspace, setModalWorkspace] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [loadingWorkspaces, setLoadingWorkspaces] = useState(false),
    [creating, setCreating] = useState(false),
    [modalError, setModalError] = useState("");
  const [isNarrow, setIsNarrow] = useState(
    () => window.matchMedia("(max-width: 930px)").matches,
  );
  const navClose = useRef<HTMLButtonElement>(null),
    navToggle = useRef<HTMLButtonElement>(null),
    taskClose = useRef<HTMLButtonElement>(null),
    taskToggle = useRef<HTMLButtonElement>(null),
    wasNavOpen = useRef(false),
    wasTasksOpen = useRef(false);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia("(max-width: 640px)").matches,
  );
  const [navOpen, setNavOpen] = useState(false),
    [tasksOpen, setTasksOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  /** The side-effect warning of a retry, shown on the job it created. */
  const [retryNotice, setRetryNotice] = useState<{ jobId: string; text: string } | null>(null);
  const lastSession = useRef<string | null>(null);
  const restored = useRef(false),
    dialog = useRef<HTMLDialogElement>(null),
    composer = useRef<HTMLTextAreaElement>(null);
  const activeSession = sessions.find(
    (session) => session.session_id === sessionId,
  );
  const activeWorker = workers.find(
    (worker) =>
      worker.worker_id === (activeSession?.worker_id ?? selectedWorker),
  );
  const workerSessions = sessions.filter(
    (session) =>
      session.kind === "worker" && session.worker_id === selectedWorker,
  );
  const selectedJob =
    jobs.find((job) => job.job_id === selectedJobId) ?? jobs.at(-1);
  const waitingCount = jobs.filter((job) => queuedStates.has(job.state)).length;
  const runningJob = jobs.find((job) => activeStates.has(job.state));
  const needsAttention =
    jobs.some((job) => job.state === "needs_attention") ||
    Boolean(activeWorker?.blocked);

  useEffect(() => {
    localStorage.setItem("worker-plane-drafts", JSON.stringify(drafts));
  }, [drafts]);

  function report(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401)
      setAuth("logged-out");
    if (!(cause instanceof DOMException && cause.name === "AbortError"))
      setError(
        cause instanceof Error ? cause.message : "无法连接主节点，请稍后重试。",
      );
  }
  async function selectMain() {
    setError("");
    setEditingSessionId(null);
    localStorage.removeItem("worker-plane-session");
    setSelectedWorker(null);
    try {
      const main = await request<Session>("/api/main");
      setSessions((current) => current.some((s) => s.session_id === main.session_id) ? current : [main, ...current]);
      setSessionId(main.session_id);
    } catch (cause) {
      report(cause);
      setSessionId(null);
    }
    setMessages([]);
    setJobs([]);
    setSelectedJobId(null);
    setNavOpen(false);
  }
  const agentName = activeSession?.kind === "main" ? "Main Agent" : "Worker Agent";
  /** A delegation card opens its child session, which is an ordinary worker session. */
  function openSessionById(id: string) {
    const session = sessions.find((s) => s.session_id === id);
    if (session) return selectSession(session);
    void request<Session[]>("/api/sessions").then((next) => {
      setSessions(next);
      const found = next.find((s) => s.session_id === id);
      if (found) selectSession(found);
    }, report);
  }
  function selectSession(session: Session) {
    setError("");
    setEditingSessionId(null);
    setSelectedWorker(session.worker_id);
    setSessionId(session.session_id);
    setMessages([]);
    setJobs([]);
    setSelectedJobId(null);
    setNavOpen(false);
    localStorage.setItem("worker-plane-session", session.session_id);
  }
  function selectWorker(worker: Worker) {
    const latest = sessions.find(
      (session) =>
        session.kind === "worker" && session.worker_id === worker.worker_id,
    );
    if (latest) selectSession(latest);
    else {
      setSelectedWorker(worker.worker_id);
      setSessionId(null);
      setMessages([]);
      setJobs([]);
      setSelectedJobId(null);
      setNavOpen(false);
    }
  }
  function openNewSession(
    workerId = selectedWorker ?? workers[0]?.worker_id ?? "",
  ) {
    setModalWorker(workerId);
    setModalWorkspace("");
    setModalError("");
    setWorkspaces([]);
    setModalOpen(true);
  }

  useEffect(() => {
    const controller = new AbortController();
    void request<{ authenticated: boolean }>("/auth/session", {
      signal: controller.signal,
    })
      .then((value) =>
        setAuth(value.authenticated ? "logged-in" : "logged-out"),
      )
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setAuth("logged-out");
          report(cause);
        }
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (auth !== "logged-in") return;
    const controller = new AbortController();
    let polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        const [nextWorkers, nextSessions] = await Promise.all([
          request<Worker[]>("/api/workers", { signal: controller.signal }),
          request<Session[]>("/api/sessions", { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setWorkers(nextWorkers);
        setSessions(nextSessions);
        if (!restored.current) {
          restored.current = true;
          const saved = nextSessions.find(
            (session) =>
              session.kind === "worker" &&
              session.session_id ===
                localStorage.getItem("worker-plane-session"),
          );
          if (saved) {
            setSelectedWorker(saved.worker_id);
            setSessionId(saved.session_id);
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) report(cause);
      } finally {
        polling = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [auth, refreshKey]);
  useEffect(() => {
    const changingSession = lastSession.current !== sessionId;
    lastSession.current = sessionId;
    if (changingSession) {
      setMessages([]);
      setJobs([]);
      setSelectedJobId(null);
    }
    if (!sessionId || auth !== "logged-in") {
      setLoadingConversation(false);
      return;
    }
    const controller = new AbortController();
    let polling = false;
    if (changingSession) setLoadingConversation(true);
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        const [nextMessages, nextJobs] = await Promise.all([
          request<Message[]>(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
            { signal: controller.signal },
          ),
          request<Job[]>(
            `/api/sessions/${encodeURIComponent(sessionId)}/jobs`,
            { signal: controller.signal },
          ),
        ]);
        if (controller.signal.aborted) return;
        setMessages(nextMessages);
        setJobs(nextJobs);
        setSelectedJobId((current) =>
          nextJobs.some((job) => job.job_id === current)
            ? current
            : (nextJobs.at(-1)?.job_id ?? null),
        );
      } catch (cause) {
        if (!controller.signal.aborted) report(cause);
      } finally {
        if (!controller.signal.aborted) setLoadingConversation(false);
        polling = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [auth, sessionId, refreshKey]);
  useEffect(() => {
    if (!modalOpen || !modalWorker) return;
    const controller = new AbortController();
    setLoadingWorkspaces(true);
    setWorkspaces([]);
    setModalWorkspace("");
    setModalError("");
    void request<{ workspaces: Workspace[] }>(
      `/api/workers/${encodeURIComponent(modalWorker)}/workspaces?all=true`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setWorkspaces(value.workspaces);
          setModalWorkspace(
            value.workspaces.length === 1
              ? value.workspaces[0].workspace_id
              : "",
          );
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setModalError(
            cause instanceof Error ? cause.message : "无法获取工作目录。",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingWorkspaces(false);
      });
    return () => controller.abort();
  }, [modalOpen, modalWorker]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const change = () => setIsMobile(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 930px)");
    const change = () => setIsNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (navOpen && isMobile) navClose.current?.focus();
    else if (wasNavOpen.current && isMobile) navToggle.current?.focus();
    if (tasksOpen && isNarrow) taskClose.current?.focus();
    else if (wasTasksOpen.current && isNarrow) taskToggle.current?.focus();
    wasNavOpen.current = navOpen;
    wasTasksOpen.current = tasksOpen;
  }, [navOpen, tasksOpen, isMobile, isNarrow]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !modalOpen) {
        setNavOpen(false);
        setTasksOpen(false);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [modalOpen]);
  useEffect(() => {
    if (modalOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modalOpen]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (loggingIn) return;
    setLoggingIn(true);
    setError("");
    try {
      await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setAuth("logged-in");
      setPassword("");
      restored.current = false;
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 401
          ? "密码不正确，请重试。"
          : cause instanceof Error
            ? cause.message
            : "登录失败。",
      );
    } finally {
      setLoggingIn(false);
    }
  }
  async function logout() {
    try {
      await request("/auth/logout", { method: "POST" });
      setAuth("logged-out");
      setWorkers([]);
      setSessions([]);
      setSelectedWorker(null);
      setSessionId(null);
      restored.current = false;
    } catch (cause) {
      report(cause);
    }
  }
  async function createSession(event: React.FormEvent) {
    event.preventDefault();
    const workspace = workspaces.find(
      (value) => value.workspace_id === modalWorkspace,
    );
    if (!workspace || creating) return;
    setCreating(true);
    try {
      const created = await request<Session>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          worker_id: modalWorker,
          workspace_id: workspace.workspace_id,
          repo_id: workspace.repo_id,
        }),
      });
      setSessions((current) => [created, ...current]);
      selectSession(created);
      setModalOpen(false);
      setError("");
    } catch (cause) {
      setModalError(cause instanceof Error ? cause.message : "创建会话失败。");
    } finally {
      setCreating(false);
    }
  }
  function beginRenameSession(session: Session) {
    setEditingSessionId(session.session_id);
    setEditingTitle(session.title ?? session.workspace_id);
    setError("");
  }
  async function renameSession(event: React.FormEvent, session: Session) {
    event.preventDefault();
    const title = editingTitle.trim();
    if (!title || Array.from(title).length > 80) {
      setError("会话名称需为 1–80 个字符。");
      return;
    }
    try {
      const updated = await request<Session>(
        `/api/sessions/${encodeURIComponent(session.session_id)}`,
        { method: "PATCH", body: JSON.stringify({ title }) },
      );
      setSessions((current) =>
        current.map((item) =>
          item.session_id === updated.session_id ? updated : item,
        ),
      );
      setEditingSessionId(null);
      setError("");
    } catch (cause) {
      report(cause);
    }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!sessionId || !text.trim() || submitting) return;
    const target = sessionId,
      message = text;
    setSubmitting(true);
    setError("");
    try {
      const result = await request<{ existing?: boolean }>(
        `/api/sessions/${encodeURIComponent(target)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            client_request_id: crypto.randomUUID(),
            message,
          }),
        },
      );
      if (!result.existing && !activeSession?.title) {
        const title = Array.from(message.trim().replace(/\s+/g, " "))
          .slice(0, 80)
          .join("");
        setSessions((current) =>
          current.map((item) =>
            item.session_id === target && !item.title
              ? { ...item, title }
              : item,
          ),
        );
      }
      setDrafts((current) => {
        if (current[target] !== message) return current;
        const next = { ...current };
        delete next[target];
        return next;
      });
      setSelectedJobId(null);
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      report(cause);
    } finally {
      setSubmitting(false);
    }
  }
  function chooseJob(job: Job) {
    setSelectedJobId(job.job_id);
    document
      .getElementById(`job-${job.job_id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const grouped = jobs.map((job) => ({
    job,
    messages: messages.filter((message) => message.job_id === job.job_id),
  }));
  const selectedJobToolFailures = selectedJob
    ? messages
        .filter((message) => message.job_id === selectedJob.job_id)
        .map((message) => ({ message: parseMessage(message), messageId: message.message_id }))
        .map(({ message, messageId }) => ({ failure: toolFailure(message), messageId, message }))
        .filter((item) => item.failure)
    : [];
  const orphanMessages = messages.filter(
    (message) => !jobs.some((job) => job.job_id === message.job_id),
  );

  if (auth === "checking")
    return (
      <div className="auth-loading">
        <span className="brand-mark">
          <Icon name="plane" />
        </span>
        <p>正在连接工作台…</p>
      </div>
    );
  if (auth === "logged-out")
    return (
      <main className="login-page">
        <section className="login-story">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="plane" />
            </span>
            <span>Worker Plane</span>
          </div>
          <div>
            <span className="eyebrow">YOUR MACHINES. ONE WORKSPACE.</span>
            <h1>
              让任务，
              <br />
              在正确的机器上完成。
            </h1>
            <p>
              独立会话、固定工作目录。
              <br />
              从每一次执行到最终结果，进度始终清晰可见。
            </p>
          </div>
          <span className="login-footnote">
            模型运行于主节点 · 工具执行于你的机器
          </span>
        </section>
        <section className="login-panel">
          <form onSubmit={login}>
            <span className="eyebrow">WELCOME BACK</span>
            <h2>登录工作台</h2>
            <p className="muted">使用管理员密码连接主节点。</p>
            <label htmlFor="password">管理员密码</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入密码"
            />
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button className="primary-button" disabled={loggingIn}>
              {loggingIn ? "正在登录…" : "进入工作台"}
              <Icon name="arrow" />
            </button>
            <span className="login-security">
              <Icon name="lock" />
              会话与执行记录仅向已登录用户开放
            </span>
          </form>
        </section>
      </main>
    );

  return (
    <div className="workspace-app">
      {tasksOpen && isNarrow && (
        <button
          className="task-scrim"
          aria-label="关闭任务时间线"
          onClick={() => setTasksOpen(false)}
        />
      )}
      {navOpen && (
        <button
          className="mobile-scrim"
          aria-label="关闭导航"
          onClick={() => setNavOpen(false)}
        />
      )}
      <aside
        className={`sidebar ${navOpen ? "sidebar-open" : ""}`}
        aria-label="工作台导航"
        inert={(isMobile && !navOpen) || (isNarrow && tasksOpen)}
      >
        <div className="brand">
          <span className="brand-mark">
            <Icon name="plane" />
          </span>
          <span>
            Worker Plane<small>REMOTE OPERATIONS</small>
          </span>
          <button
            ref={navClose}
            className="icon-button mobile-only"
            aria-label="关闭导航"
            onClick={() => setNavOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <button
          className={`main-agent nav-button ${selectedWorker === null ? "is-selected" : ""}`}
          onClick={() => void selectMain()}
        >
          <span className="agent-icon">
            <Icon name="grid" />
          </span>
          <span>
            <strong>Main Agent</strong>
            <small>多机器任务协调</small>
          </span>
        </button>
        <div className="sidebar-section-label">
          <span>机器</span>
          <span>{workers.length.toString().padStart(2, "0")}</span>
        </div>
        <div className="worker-navigation">
          {workers.length ? (
            workers.map((worker) => {
              const state = workerStatus(worker);
              return (
                <button
                  key={worker.worker_id}
                  className={`worker-nav nav-button ${selectedWorker === worker.worker_id ? "is-selected" : ""}`}
                  onClick={() => selectWorker(worker)}
                  aria-pressed={selectedWorker === worker.worker_id}
                >
                  <span className="machine-icon">
                    <Icon name="server" />
                    <i
                      className={`connection-dot ${worker.online ? "online" : "offline"}`}
                    />
                  </span>
                  <span className="worker-name">
                    <strong>{worker.worker_id}</strong>
                    <small>{worker.online ? "在线" : "离线"}</small>
                  </span>
                  <span className={`worker-state tone-${state.tone}`}>
                    {state.label}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="sidebar-empty">还没有注册的机器</div>
          )}
        </div>
        <div className="sidebar-section-label session-section">
          <span>{selectedWorker ? "独立会话" : "会话"}</span>
          <button
            className="icon-button"
            aria-label="新建独立会话"
            disabled={!workers.length}
            onClick={() => openNewSession()}
          >
            <Icon name="plus" />
          </button>
        </div>
        <div className="session-navigation">
          {selectedWorker ? (
            workerSessions.length ? (
              workerSessions.map((session) => (
                <div className="session-nav-row" key={session.session_id}>
                  {editingSessionId === session.session_id ? (
                    <form
                      className="session-title-editor"
                      onSubmit={(event) => void renameSession(event, session)}
                    >
                      <label className="sr-only" htmlFor={`session-title-${session.session_id}`}>
                        会话名称
                      </label>
                      <input
                        id={`session-title-${session.session_id}`}
                        autoFocus
                        maxLength={160}
                        value={editingTitle}
                        onChange={(event) => setEditingTitle(event.target.value)}
                      />
                      <div>
                        <button type="submit" aria-label="保存会话名称">
                          <Icon name="check" />
                        </button>
                        <button
                          type="button"
                          aria-label="取消重命名"
                          onClick={() => setEditingSessionId(null)}
                        >
                          <Icon name="close" />
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <button
                        className={`session-nav ${session.session_id === sessionId ? "is-selected" : ""}`}
                        onClick={() => selectSession(session)}
                      >
                        <Icon name="chat" />
                        <span>
                          <strong title={session.title ?? session.workspace_id}>
                            {session.title ?? session.workspace_id}
                          </strong>
                          <small>
                            {session.parent_job_id ? "委派 · " : ""}
                            {time(session.created_at, true)} ·{" "}
                            {session.session_id.slice(0, 6)}
                          </small>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="session-rename"
                        aria-label={`重命名会话 ${session.title ?? session.workspace_id}`}
                        onClick={() => beginRenameSession(session)}
                      >
                        <Icon name="write" />
                      </button>
                    </>
                  )}
                </div>
              ))
            ) : (
              <div className="sidebar-empty">
                为这台机器新建一个会话，
                <br />
                开始你的第一个任务。
              </div>
            )
          ) : (
            <div className="sidebar-empty">选择机器，查看独立会话。</div>
          )}
        </div>
        <button
          className="new-session-button"
          disabled={!workers.length}
          onClick={() => openNewSession()}
        >
          <Icon name="plus" />
          新建独立会话
        </button>
        <div className="sidebar-footer">
          <span className="admin-avatar">A</span>
          <span>
            <strong>管理员</strong>
            <small>个人工作台</small>
          </span>
          <button
            className="icon-button"
            aria-label="退出登录"
            onClick={() => void logout()}
          >
            <Icon name="logout" />
          </button>
        </div>
      </aside>
      <main
        className="workspace-main"
        inert={(isMobile && navOpen) || (isNarrow && tasksOpen)}
      >
        <header className="workspace-header">
          <div className="header-title">
            <button
              ref={navToggle}
              className="icon-button mobile-only"
              aria-label="打开导航"
              onClick={() => {
                setTasksOpen(false);
                setNavOpen(true);
              }}
            >
              <Icon name="menu" />
            </button>
            <span className="breadcrumb">
              工作台
              <Icon name="chevron" />
              {selectedWorker ?? "Main Agent"}
            </span>
            <h1>
              {activeSession?.title ?? activeSession?.workspace_id ??
                (selectedWorker ? "独立会话" : "Main Agent")}
            </h1>
          </div>
          <div className="header-actions">
            {activeWorker && (
              <>
                <span
                  className={`connection-label ${activeWorker.online ? "is-online" : ""}`}
                >
                  <i />
                  {activeWorker.online ? "在线" : "离线"}
                </span>
                <span
                  className={`worker-state tone-${workerStatus(activeWorker).tone}`}
                >
                  {workerStatus(activeWorker).label}
                </span>
              </>
            )}
            <button
              ref={taskToggle}
              className="icon-button task-toggle"
              aria-label="查看任务时间线"
              aria-expanded={tasksOpen}
              onClick={() => {
                setNavOpen(false);
                setTasksOpen((value) => !value);
              }}
            >
              <Icon name="clock" />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={() => setError("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {selectedWorker === null && !sessionId ? (
          <div className="main-agent-home">
            <div className="welcome-topline">
              <span className="eyebrow">MAIN AGENT</span>

            </div>
            <h2>
              一个目标，
              <br />
              让多台机器协同完成。
            </h2>
            <p className="welcome-description">
              Main Agent 把目标拆成步骤，委派给各台机器的独立会话，等前置步骤验证通过再继续。
            </p>
            <button className="primary-button" onClick={() => void selectMain()}>
              <Icon name="chat" />
              开始 Main Agent 对话
            </button>
            <div className="capability-strip">
              <span>
                <Icon name="server" />
                查看机器
              </span>
              <Icon name="chevron" />
              <span>
                <Icon name="arrow" />
                委派任务
              </span>
              <Icon name="chevron" />
              <span>
                <Icon name="check" />
                汇总结果
              </span>
            </div>
            <div className="section-heading">
              <h3>你的机器</h3>
              <span>
                {workers.filter((worker) => worker.online).length} /{" "}
                {workers.length} 在线
              </span>
            </div>
            <div className="machine-cards">
              {workers.map((worker) => {
                const state = workerStatus(worker);
                return (
                  <button
                    className="machine-card"
                    key={worker.worker_id}
                    onClick={() => selectWorker(worker)}
                  >
                    <div>
                      <span className="machine-card-icon">
                        <Icon name="server" />
                      </span>
                      <span className={`worker-state tone-${state.tone}`}>
                        {state.label}
                      </span>
                    </div>
                    <strong>{worker.worker_id}</strong>
                    <span className="machine-card-bottom">
                      <span
                        className={`connection-label ${worker.online ? "is-online" : ""}`}
                      >
                        <i />
                        {worker.online ? "在线" : "离线"}
                      </span>
                      <span>
                        打开会话
                        <Icon name="arrow" />
                      </span>
                    </span>
                  </button>
                );
              })}
              {!workers.length && (
                <div className="empty-state">
                  <Icon name="server" />
                  <h3>连接你的第一台机器</h3>
                  <p>注册 worker 后，它会出现在这里。</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {activeSession?.kind === "main" ? (
            <div className="target-bar">
              <Icon name="grid" />
              <span>Main Agent</span>
              <strong>协调多台机器</strong>
              <span className="target-repo">任务委派到各机器的独立会话，文件不会在机器之间自动传输</span>
            </div>
            ) : (
            <div className="target-bar">
              <Icon name="lock" />
              <span>固定目标</span>
              <strong>{selectedWorker}</strong>
              <span className="target-separator">/</span>
              <strong>
                {activeSession?.workspace_id ?? "尚未选择工作目录"}
              </strong>
              {activeSession?.repo_id && (
                <span className="target-repo" title={activeSession.repo_id}>
                  {activeSession.repo_id}
                </span>
              )}
              {activeSession?.parent_job_id && (
                <button type="button" className="subtle-badge" onClick={() => void selectMain()} title="返回 Main Agent">
                  Main Agent 委派
                </button>
              )}
            </div>
            )}
            {needsAttention && (
              <div className="attention-banner">
                <Icon name="alert" />
                <div>
                  <strong>这台机器需要核对</strong>
                  <p>
                    执行状态尚未确认。机器会保持占用，当前任务不会自动重跑。
                  </p>
                </div>
              </div>
            )}
            <div
              className="conversation-scroll"
              aria-label="会话记录"
              aria-busy={loadingConversation}
            >
              {loadingConversation ? (
                <div className="empty-state">
                  <span className="loading-indicator" />
                  <p>正在读取会话记录…</p>
                </div>
              ) : !sessionId ? (
                <div className="empty-state">
                  <span className="empty-icon">
                    <Icon name="chat" />
                  </span>
                  <h2>为 {selectedWorker} 开始一个独立会话</h2>
                  <p>明确选择工作目录后，这个会话始终在同一目标上执行。</p>
                  <button
                    className="primary-button"
                    onClick={() => openNewSession()}
                  >
                    <Icon name="plus" />
                    新建独立会话
                  </button>
                </div>
              ) : !messages.length ? (
                <div className="empty-state">
                  <span className="empty-icon">
                    <Icon name="terminal" />
                  </span>
                  <h2>你想在这台机器上完成什么？</h2>
                  <p>
                    描述目标，Agent 会在 {activeSession?.workspace_id}{" "}
                    中读取文件、修改内容或运行命令。
                  </p>
                  <div className="prompt-suggestions">
                    {[
                      "检查项目状态并总结当前改动",
                      "运行项目校验并解释结果",
                    ].map((prompt) => (
                      <button
                        key={prompt}
                        onClick={() => {
                          setText(prompt);
                          composer.current?.focus();
                        }}
                      >
                        {prompt}
                        <Icon name="arrow" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="conversation-inner">
                  {grouped.map((group) => {
                    const toolMessages = group.messages.filter(
                      (message) => parseMessage(message).role === "tool",
                    );
                    const resultMessages = group.messages.filter(
                      (message) => parseMessage(message).role !== "tool",
                    );
                    return (
                      <section
                        className={`turn-group ${group.job.job_id === selectedJob?.job_id ? "selected-turn" : ""}`}
                        id={`job-${group.job.job_id}`}
                        key={group.job.job_id}
                      >
                        <div className="turn-divider">
                          <span>{time(group.job.created_at, true)}</span>
                          <Status state={group.job.state} />
                        </div>
                        {resultMessages.map((message) => (
                          <ChatMessage
                            key={message.message_id}
                            message={message}
                            agent={agentName}
                            onOpenSession={openSessionById}
                          />
                        ))}
                        {toolMessages.length > 0 && (
                          <details className="execution-details" open={activeSession?.kind === "main"}>
                            <summary>
                              执行详情 · {toolMessages.length} 次工具调用
                            </summary>
                            <div>
                              {toolMessages.map((message) => (
                                <ChatMessage
                                  key={message.message_id}
                                  message={message}
                                  agent={agentName}
                                  onOpenSession={openSessionById}
                                />
                              ))}
                            </div>
                          </details>
                        )}
                      </section>
                    );
                  })}
                  {orphanMessages.map((message) => (
                    <ChatMessage key={message.message_id} message={message} agent={agentName} onOpenSession={openSessionById} />
                  ))}
                  {runningJob && (
                    <div className="agent-working">
                      <span className="working-dots">
                        <i />
                        <i />
                        <i />
                      </span>
                      任务正在执行，结果会持续更新。
                    </div>
                  )}
                </div>
              )}
            </div>
            <form className="composer" onSubmit={send}>
              <div className="composer-input">
                <textarea
                  ref={composer}
                  aria-label="任务消息"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter sends; Shift+Enter adds a line. Never interrupt IME composition.
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }}
                  placeholder={
                    sessionId
                      ? "描述任务，或继续这个会话…"
                      : "新建会话后即可提交任务"
                  }
                  disabled={!sessionId || submitting}
                  maxLength={32000}
                  rows={3}
                />
                <button
                  className="send-button"
                  aria-label="提交任务"
                  disabled={!sessionId || !text.trim() || submitting}
                >
                  {submitting ? (
                    <span className="loading-indicator" />
                  ) : (
                    <Icon name="arrow" />
                  )}
                </button>
              </div>
              <div className="composer-footnote">
                <span>
                  <Icon name="lock" />
                  {activeWorker?.blocked
                    ? "消息将保留在队列中，等待机器完成核对。"
                    : !activeWorker?.online
                      ? "机器离线时，消息会等待上线后执行。"
                      : activeWorker?.active_job_id
                        ? "机器正在执行任务，新消息会按顺序排队。"
                        : "消息仅在当前固定工作目录执行。"}
                </span>
                {text.length > 30000 && (
                  <span>{text.length.toLocaleString()} / 32,000</span>
                )}
              </div>
            </form>
          </>
        )}
      </main>
      <aside
        className={`task-panel ${tasksOpen ? "task-panel-open" : ""}`}
        aria-label="任务时间线"
      >
        <div className="task-panel-heading">
          <div>
            <span className="eyebrow">ACTIVITY</span>
            <h2>任务时间线</h2>
          </div>
          <button
            ref={taskClose}
            className="icon-button task-close"
            aria-label="关闭任务时间线"
            onClick={() => setTasksOpen(false)}
          >
            <Icon name="close" />
          </button>
          <span className="task-count">{jobs.length}</span>
        </div>
        <div className="task-summary">
          <div>
            <strong>
              {jobs.filter((job) => activeStates.has(job.state)).length}
            </strong>
            <span>执行中</span>
          </div>
          <div>
            <strong>{waitingCount}</strong>
            <span>等待中</span>
          </div>
          <div>
            <strong>
              {jobs.filter((job) => job.state === "succeeded").length}
            </strong>
            <span>已完成</span>
          </div>
        </div>
        <div className="task-list">
          {[...jobs].reverse().map((job) => {
            const failures = messages
              .filter((message) => message.job_id === job.job_id)
              .map((message) => toolFailure(parseMessage(message)))
              .filter(Boolean);
            return (
              <button
                className={`task-item ${selectedJob?.job_id === job.job_id ? "is-selected" : ""}`}
                key={job.job_id}
                onClick={() => chooseJob(job)}
              >
                <span className={`timeline-dot timeline-${job.state}`} />
                <span className="task-item-content">
                  <span className="task-item-top">
                    <Status state={job.state} />
                    <time>{time(job.created_at)}</time>
                  </span>
                  <strong>{job.input_text || "会话任务"}</strong>
                  {failures.length > 0 && (
                    <span className="task-command-failure">
                      <Icon name="alert" />
                      {failures.length} 个工具调用失败
                    </span>
                  )}
                  {queuedStates.has(job.state) && (
                    <span className="task-queue-position">
                      {job.state === "waiting_worker"
                        ? "等待目标机器上线"
                        : "按机器顺序执行"}
                      {job.queue_position
                        ? ` · 队列第 ${job.queue_position} 位`
                        : ""}
                    </span>
                  )}
                  <code>{job.job_id.slice(0, 8)}</code>
                </span>
              </button>
            );
          })}
          {!jobs.length && (
            <div className="task-empty">
              <Icon name="clock" />
              <p>每次提交都会生成一个任务。</p>
              <span>执行进度与结果会在这里记录。</span>
            </div>
          )}
        </div>
        {selectedJob && (
          <div className="job-inspector">
            <span className="eyebrow">SELECTED TASK</span>
            <h3>任务详情</h3>
            <dl>
              <div>
                <dt>提交时间</dt>
                <dd>{time(selectedJob.created_at, true)}</dd>
              </div>
              <div>
                <dt>开始执行</dt>
                <dd>{time(selectedJob.started_at, true)}</dd>
              </div>
              <div>
                <dt>工具调用</dt>
                <dd>
                  {
                    messages.filter(
                      (message) =>
                        message.job_id === selectedJob.job_id &&
                        parseMessage(message).role === "tool",
                    ).length
                  }{" "}
                  次
                </dd>
              </div>
              <BudgetRows job={selectedJob} now={Date.now()} />
              {selectedJob.state === "waiting_worker" &&
                selectedJob.wait_until && (
                  <div>
                    <dt>等待截止</dt>
                    <dd>{time(selectedJob.wait_until, true)}</dd>
                  </div>
                )}
            </dl>
            <details className="technical-detail">
              <summary>任务标识</summary>
              <code>{selectedJob.job_id}</code>
            </details>
            {(selectedJob.state === "needs_attention" || Boolean(activeWorker?.blocked)) && (
              <AttentionPanel
                job={selectedJob}
                workerId={selectedJob.worker_id}
                workerBlocked={Boolean(activeWorker?.blocked)}
                refreshKey={refreshKey}
                onDone={() => setRefreshKey((value) => value + 1)}
                onError={report}
              />
            )}
            {selectedJobToolFailures.length > 0 && (
              <div className="inspector-command-failures" role="status">
                <strong><Icon name="alert" /> 工具调用失败</strong>
                {selectedJobToolFailures.map(({ failure, message, messageId }) => (
                  <div key={messageId}>
                    <code>{message.arguments?.command ?? "工具调用"}</code>
                    <span>{failure}</span>
                  </div>
                ))}
              </div>
            )}
            {retryNotice?.jobId === selectedJob.job_id && (
              <p className="attention-note">{retryNotice.text}</p>
            )}
            <div className="job-actions">
              <CancelButton job={selectedJob} onDone={() => setRefreshKey((value) => value + 1)} onError={report} />
              <RetryButton
                job={selectedJob}
                onDone={(jobId, notice) => { setRetryNotice({ jobId, text: notice }); setSelectedJobId(jobId); setRefreshKey((value) => value + 1); }}
                onError={report}
              />
            </div>
          </div>
        )}
        <div className="task-panel-footer">
          <Icon name="lock" />
          <span>会话目标固定 · 每台机器串行执行</span>
        </div>
      </aside>
      <dialog
        ref={dialog}
        className="session-dialog"
        onCancel={(event) => {
          if (creating) event.preventDefault();
          else setModalOpen(false);
        }}
        onClose={() => setModalOpen(false)}
        aria-labelledby="session-dialog-title"
      >
        <form onSubmit={createSession}>
          <div className="dialog-heading">
            <span className="dialog-icon">
              <Icon name="chat" />
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭新建会话"
              disabled={creating}
              onClick={() => setModalOpen(false)}
            >
              <Icon name="close" />
            </button>
          </div>
          <h2 id="session-dialog-title">新建独立会话</h2>
          <p className="muted">
            选择执行机器和工作目录。创建后，这个会话的目标保持固定。
          </p>
          <label htmlFor="session-worker">执行机器</label>
          <select
            id="session-worker"
            value={modalWorker}
            disabled={creating}
            onChange={(event) => setModalWorker(event.target.value)}
          >
            {workers.map((worker) => (
              <option key={worker.worker_id} value={worker.worker_id}>
                {worker.worker_id} · {worker.online ? "在线" : "离线"}
              </option>
            ))}
          </select>
          <label>工作目录</label>
          <div
            className="workspace-options"
            role="radiogroup"
            aria-label="工作目录"
          >
            {loadingWorkspaces ? (
              <p className="muted">正在获取工作目录…</p>
            ) : (
              workspaces.map((workspace) => (
                <label
                  className={`workspace-option ${modalWorkspace === workspace.workspace_id ? "is-selected" : ""}`}
                  key={workspace.workspace_id}
                >
                  <input
                    type="radio"
                    name="workspace"
                    value={workspace.workspace_id}
                    checked={modalWorkspace === workspace.workspace_id}
                    disabled={creating}
                    onChange={() => setModalWorkspace(workspace.workspace_id)}
                  />
                  <span>
                    <strong>
                      {workspace.workspace_id}
                      {workspace.is_default ? <small>默认目录</small> : null}
                    </strong>
                    <span>{workspace.repo_id}</span>
                    <code>{workspace.path}</code>
                  </span>
                </label>
              ))
            )}
          </div>
          {modalError && (
            <p className="form-error" role="alert">
              {modalError}
            </p>
          )}
          <div className="dialog-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={creating}
              onClick={() => setModalOpen(false)}
            >
              取消
            </button>
            <button
              className="primary-button"
              disabled={!modalWorkspace || creating || loadingWorkspaces}
            >
              {creating ? "正在创建…" : "创建会话"}
              <Icon name="arrow" />
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
