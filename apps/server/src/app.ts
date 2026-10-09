import Fastify from "fastify";
import type { FastifyLoggerOptions } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import argon2 from "argon2";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DEFAULT_BUDGET, ExecutionCoordinator, workspaceCurrent, type Budget, type Resolution, type ScriptStep } from "./execution.js";
import { mainFault } from "./fault.js";
import { createJob, mainSession } from "./jobs.js";
import { registerFeed, sessionJobs, workerViews } from "./feed.js";
import type Database from "better-sqlite3";
import {
  parseFrame,
  requestHash,
  stringifyFrame,
  MAX_FRAME_BYTES,
} from "@worker-plane/protocol";
import type { WorkerFrame } from "@worker-plane/protocol";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
export async function createApp(
  db: Database.Database,
  origin: string,
  options: {
    now?: () => number;
    logging?: boolean;
    logStream?: FastifyLoggerOptions["stream"];
    runJob?: (job:unknown)=>Promise<void>;
    dataDir?: string;
    fakeScript?: (job: any) => ScriptStep[];
    toolResultTimeoutMs?: number;
    waitSweepMs?: number;
    logCapacityBytes?: number;
    budget?: Partial<Budget>;
    feed?: { pollMs?: number; pruneMs?: number; keep?: number; maxAgeMs?: number };
  } = {},
) {
  const now = options.now ?? Date.now;
  if (new URL(origin).protocol !== "https:")
    throw new Error("HTTPS origin required");
  const app = Fastify({
    logger:
      options.logging === false
        ? false
        : {
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.body.password",
              'res.headers["set-cookie"]',
            ],
            ...(options.logStream ? { stream: options.logStream } : {}),
          },
    bodyLimit: 65536,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
  const connections = new Map<
    string,
    {
      epoch: number;
      socket: import("ws").WebSocket;
      tokenDigest: string;
    }
  >();
  const budget = { ...DEFAULT_BUDGET, ...options.budget };
  const coordinator = new ExecutionCoordinator(db, connections, now, options.runJob as ((job:any)=>Promise<void>)|undefined, { budget, dataDir: options.dataDir, fakeScript: options.fakeScript, toolResultTimeoutMs: options.toolResultTimeoutMs, logCapacityBytes: options.logCapacityBytes });
  let shuttingDown = false;
  let recovered = false;
  // Main jobs need no worker: a restart resumes them right away.
  setImmediate(() => { coordinator.advance(); recovered = true; void coordinator.pumpMain(); });
  /** Scheduling is ready once the startup recovery pass ran, the database answers and shutdown has not begun. */
  const schedulingReady = () => {
    if (!recovered || shuttingDown) return false;
    try { return db.prepare("SELECT 1").pluck().get() === 1; } catch { return false; }
  };
  /** Inside a transaction: a new job with its own budget root, at the back of its worker's queue. */
  const insertJob = (session: any, clientRequestId: string, message: string, requestHash: string) =>
    createJob(db, now, { session, clientRequestId, message, requestHash, budget });
  /** After commit: start whatever the new job can start. */
  const wake = (session: { kind: string; worker_id: string | null }) =>
    session.kind === "main" ? void coordinator.pumpMain() : void coordinator.pump(session.worker_id!);
  const offline = (id: string, epoch: number) => {
    if (shuttingDown) return;
    return db
      .prepare(
        "UPDATE workers SET online=0,reconciled=0 WHERE worker_id=? AND connection_epoch=?",
      )
      .run(id, epoch);
  };
  const loggedIn = (token: string | undefined) =>
    Boolean(token && db.prepare("SELECT 1 FROM auth_sessions WHERE digest=? AND expires_at>?").get(digest(token), now()));
  app.addHook("onRequest", async (req, reply) => {
    if (
      req.url.split("?")[0] === "/health" ||
      req.url.split("?")[0] === "/auth/login" ||
      req.url.split("?")[0] === "/auth/session" ||
      req.url.split("?")[0] === "/ws/worker"
    )
      return;
    const token = req.cookies.session;
    const session = token
      ? (db
          .prepare(
            "SELECT csrf FROM auth_sessions WHERE digest=? AND expires_at>?",
          )
          .get(digest(token), now()) as { csrf: string } | undefined)
      : undefined;
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const csrf = req.headers["x-csrf-token"];
      if (
        req.headers.origin !== origin ||
        typeof csrf !== "string" ||
        Buffer.byteLength(csrf) !== Buffer.byteLength(session.csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))
      )
        return reply.code(403).send({ error: "csrf" });
    }
  });
  app.get("/health", async () => ({
    alive: true,
    scheduling_ready: schedulingReady(),
    phase: "P6",
  }));
  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: 60000 } } },
    async (req, reply) => {
      if (req.headers.origin !== origin)
        return reply.code(403).send({ error: "origin" });
      const password = (req.body as { password?: unknown } | null)?.password;
      const admin = db
        .prepare("SELECT password_hash FROM administrators WHERE id=1")
        .get() as { password_hash: string } | undefined;
      if (
        typeof password !== "string" ||
        password.length > 1024 ||
        !admin ||
        !(await argon2.verify(admin.password_hash, password))
      )
        return reply.code(401).send({ error: "unauthorized" });
      const token = secret(),
        csrf = secret();
      db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(
        digest(token),
        csrf,
        now() + 8 * 3600000,
      );
      return reply
        .setCookie("session", token, {
          secure: true,
          httpOnly: true,
          sameSite: "strict",
          path: "/",
          maxAge: 8 * 3600,
        })
        .send({ csrf });
    },
  );
  app.post("/auth/logout", async (req, reply) => {
    db.prepare("DELETE FROM auth_sessions WHERE digest=?").run(
      digest(req.cookies.session!),
    );
    return reply.clearCookie("session", { path: "/" }).send({ ok: true });
  });
  app.get("/auth/session", async (req) => {
    const token=req.cookies.session;
    const session=token?db.prepare("SELECT csrf,expires_at FROM auth_sessions WHERE digest=? AND expires_at>?").get(digest(token),now()) as {csrf:string;expires_at:number}|undefined:undefined;
    if(!session) return {authenticated:false};
    return {authenticated:true,csrf:session.csrf,expires_at:session.expires_at};
  });
  app.get("/api/workers", async () => workerViews(db));
  registerFeed(app, db, now, loggedIn, options.feed);
  app.get("/api/main", async () => mainSession(db, now));
  app.get("/api/sessions", async () => db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all());
  app.post("/api/sessions", async (req, reply) => {
    const body=req.body as {worker_id?:unknown;workspace_id?:unknown;repo_id?:unknown}|null;
    if(typeof body?.worker_id!=="string"||typeof body.workspace_id!=="string") return reply.code(400).send({error:"worker_and_workspace_required"});
    const workspace=db.prepare("SELECT * FROM workspaces WHERE worker_id=? AND workspace_id=?").get(body.worker_id,body.workspace_id) as any;
    const worker=db.prepare("SELECT 1 FROM workers WHERE worker_id=?").get(body.worker_id);
    if(!worker||!workspace) return reply.code(404).send({error:"worker_or_workspace_not_found"});
    if(body.repo_id!==undefined&&(typeof body.repo_id!=="string"||body.repo_id!==workspace.repo_id)) return reply.code(409).send({error:"repo_mismatch"});
    const session_id=randomBytes(16).toString("hex");
    db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,created_at) VALUES(?,'worker',?,?,?,?,?,?)").run(session_id,body.worker_id,body.workspace_id,workspace.config_version,workspace.repo_id,workspace.path,now());
    return reply.code(201).send(db.prepare("SELECT * FROM sessions WHERE session_id=?").get(session_id));
  });
  app.patch<{ Params: { session_id: string } }>(
    "/api/sessions/:session_id",
    async (req, reply) => {
      const body = req.body as { title?: unknown } | null;
      if (typeof body?.title !== "string")
        return reply.code(400).send({ error: "invalid_session_title" });
      const title = body.title.trim().replace(/\s+/g, " ");
      if (!title || Array.from(title).length > 80)
        return reply.code(400).send({ error: "invalid_session_title" });
      const exists = db
        .prepare("SELECT 1 FROM sessions WHERE session_id=?")
        .get(req.params.session_id);
      if (!exists) return reply.code(404).send({ error: "session_not_found" });
      db.prepare("UPDATE sessions SET title=? WHERE session_id=?").run(
        title,
        req.params.session_id,
      );
      return db
        .prepare("SELECT * FROM sessions WHERE session_id=?")
        .get(req.params.session_id);
    },
  );
  app.get<{Params:{session_id:string}}>("/api/sessions/:session_id/messages",async(req,reply)=>{
    if(!db.prepare("SELECT 1 FROM sessions WHERE session_id=?").get(req.params.session_id)) return reply.code(404).send({error:"session_not_found"});
    return db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY seq").all(req.params.session_id);
  });
  app.get<{Params:{session_id:string}}>("/api/sessions/:session_id/jobs",async(req,reply)=>{
    if(!db.prepare("SELECT 1 FROM sessions WHERE session_id=?").get(req.params.session_id)) return reply.code(404).send({error:"session_not_found"});
    return sessionJobs(db, req.params.session_id);
  });
  app.post<{Params:{session_id:string}}>("/api/sessions/:session_id/messages",async(req,reply)=>{
    const body=req.body as {client_request_id?:unknown;message?:unknown}|null;
    if(typeof body?.client_request_id!=="string"||!body.client_request_id||body.client_request_id.length>128||typeof body.message!=="string"||!body.message.trim()||body.message.length>32000) return reply.code(400).send({error:"invalid_message"});
    const session=db.prepare("SELECT * FROM sessions WHERE session_id=?").get(req.params.session_id) as any;
    if(!session) return reply.code(404).send({error:"session_not_found"});
    const requestHash=digest(JSON.stringify({message:body.message}));
    const outcome=db.transaction(()=>{
      const existing=db.prepare("SELECT job_id,request_hash,state FROM jobs WHERE session_id=? AND client_request_id=?").get(session.session_id,body.client_request_id) as any;
      if(existing) return existing.request_hash===requestHash?{existing:true,conflict:false,job_id:existing.job_id,state:existing.state}:{existing:true,conflict:true};
      // Checked after the idempotency lookup: a retry of an accepted message returns its job.
      if(session.kind==="worker"&&!workspaceCurrent(db,session.session_id)) return {existing:false,conflict:false,stale:true};
      const defaultTitle = Array.from(
        (body.message as string).trim().replace(/\s+/g, " "),
      )
        .slice(0, 80)
        .join("");
      db.prepare(
        "UPDATE sessions SET title=? WHERE session_id=? AND title IS NULL",
      ).run(defaultTitle, session.session_id);
      return {
        existing: false,
        conflict: false,
        ...insertJob(
          session,
          body.client_request_id as string,
          body.message as string,
          requestHash,
        ),
      };
    }).immediate();
    if(outcome.conflict) return reply.code(409).send({error:"idempotency_conflict"});
    if("stale" in outcome) return reply.code(409).send({error:"workspace_version_changed"});
    if(outcome.existing) return outcome;
    if(outcome.state==="queued") wake(session);
    return reply.code(202).send({job_id:outcome.job_id,state:outcome.state});
  });
  app.post<{Params:{job_id:string}}>("/api/jobs/:job_id/cancel",async(req,reply)=>{
    const state=coordinator.cancel(req.params.job_id);
    return state?{state}:reply.code(404).send({error:"job_not_found"});
  });
  app.get<{Params:{job_id:string}}>("/api/jobs/:job_id/usage",async(req,reply)=>coordinator.usage(req.params.job_id)??reply.code(404).send({error:"job_not_found"}));
  app.get("/api/attention",async()=>coordinator.attentionView());
  app.post<{Params:{job_id:string}}>("/api/jobs/:job_id/abandon",async(req,reply)=>{
    const note=(req.body as {note?:unknown}|null)?.note;
    if(typeof note!=="string"||!note.trim()||note.length>4000) return reply.code(400).send({error:"note_required"});
    const outcome=coordinator.abandon(req.params.job_id,note);
    if("error" in outcome) return reply.code(outcome.error==="job_not_found"?404:409).send(outcome);
    return outcome;
  });
  app.post<{Params:{worker_id:string}}>("/api/workers/:worker_id/unblock",async(req,reply)=>{
    const body=req.body as {evidence?:unknown;resolutions?:unknown}|null;
    const outcomes=new Set(["executed","not_executed","terminated"]);
    if(typeof body?.evidence!=="string"||!body.evidence.trim()||body.evidence.length>8000) return reply.code(400).send({error:"evidence_required"});
    if(!Array.isArray(body.resolutions)||body.resolutions.some((r:any)=>typeof r?.call_id!=="string"||!outcomes.has(r?.outcome))) return reply.code(400).send({error:"invalid_resolutions"});
    const outcome=coordinator.unblock(req.params.worker_id,body.evidence,(body.resolutions as Resolution[]).map(({call_id,outcome})=>({call_id,outcome})));
    if("error" in outcome) return reply.code(outcome.error==="worker_not_found"?404:409).send(outcome);
    return outcome;
  });
  app.post<{Params:{job_id:string}}>("/api/jobs/:job_id/retry",async(req,reply)=>{
    const outcome=db.transaction(()=>{
      const job=db.prepare("SELECT j.*,s.session_id FROM jobs j JOIN sessions s USING(session_id) WHERE j.job_id=?").get(req.params.job_id) as any;
      if(!job) return {code:404,error:"job_not_found"};
      if(!["succeeded","failed","cancelled"].includes(job.state)) return {code:409,error:"job_not_terminal"};
      // A delegated job shares its parent's budget root; a retry would escape it.
      if(job.parent_job_id) return {code:409,error:"delegated_job_retry_not_allowed"};
      const session=db.prepare("SELECT * FROM sessions WHERE session_id=?").get(job.session_id) as any;
      if(session.kind==="worker"&&!workspaceCurrent(db,session.session_id)) return {code:409,error:"workspace_version_changed"};
      const created=insertJob(session,`retry:${job.job_id}:${randomBytes(8).toString("hex")}`,job.input_text,job.request_hash);
      // attention_actions is per worker; a Main job retry is recorded as an event.
      if(job.worker_id) db.prepare("INSERT INTO attention_actions(action_id,worker_id,job_id,action,evidence,created_at) VALUES(?,?,?,'retry',?,?)").run(randomBytes(16).toString("hex"),job.worker_id,job.job_id,JSON.stringify({new_job_id:created.job_id}),now());
      else db.prepare("INSERT INTO events(created_at,content_json) VALUES(?,?)").run(now(),JSON.stringify({type:"job_retried",job_id:job.job_id,new_job_id:created.job_id}));
      return {code:202,...created,session};
    }).immediate();
    if("error" in outcome) return reply.code(outcome.code).send({error:outcome.error});
    if(outcome.state==="queued") wake(outcome.session);
    return reply.code(202).send({job_id:outcome.job_id,state:outcome.state,retry_of:req.params.job_id,notice:"新任务不会知道原任务做过什么；请先核对原任务已产生的副作用。"});
  });
  app.get<{Params:{job_id:string;call_id:string};Querystring:{stream?:string;from_seq?:string}}>("/api/jobs/:job_id/calls/:call_id/logs",async(req,reply)=>{
    const stream=req.query.stream??"stdout";
    const fromSeq=Number(req.query.from_seq??0);
    if((stream!=="stdout"&&stream!=="stderr")||!Number.isSafeInteger(fromSeq)||fromSeq<0) return reply.code(400).send({error:"invalid_log_query"});
    const log=coordinator.readLog(req.params.job_id,req.params.call_id,stream,fromSeq);
    return log??reply.code(404).send({error:"log_not_found"});
  });
  app.get<{
    Params: { worker_id: string };
    Querystring: { workspace_id?: string; all?: string };
  }>("/api/workers/:worker_id/workspaces", async (req, reply) => {
    const workspaces = db
      .prepare(
        "SELECT worker_id,workspace_id,config_version,path,repo_id,is_default FROM workspaces WHERE worker_id=? ORDER BY workspace_id",
      )
      .all(req.params.worker_id) as Array<{
      worker_id: string;
      workspace_id: string;
      config_version: number;
      path: string;
      repo_id: string;
      is_default: number;
    }>;
    if (workspaces.length === 0)
      return reply.code(404).send({ error: "worker_or_workspace_not_found" });
    if(req.query.all==="true") return {workspaces};
    if (req.query.workspace_id !== undefined) {
      const workspace = workspaces.find(
        (item) => item.workspace_id === req.query.workspace_id,
      );
      return workspace
        ? { workspace }
        : reply.code(404).send({ error: "workspace_not_found" });
    }
    if (workspaces.length > 1)
      return reply.code(409).send({ error: "workspace_selection_required" });
    return { workspace: workspaces[0] };
  });
  app.post("/api/worker-tokens", async (req, reply) => {
    const id = (req.body as { worker_id?: unknown } | null)?.worker_id;
    if (typeof id !== "string" || !id.length || id.length > 128)
      return reply.code(400).send({ error: "worker_id" });
    const token = secret();
    db.prepare("INSERT INTO worker_tokens VALUES (?,?,NULL)").run(
      digest(token),
      id,
    );
    return { token, worker_id: id };
  });
  app.post("/api/worker-tokens/revoke", async (req, reply) => {
    const token = (req.body as { token?: unknown } | null)?.token;
    if (typeof token !== "string")
      return reply.code(400).send({ error: "token" });
    const tokenDigest = digest(token);
    const row = db
      .prepare(
        "SELECT worker_id FROM worker_tokens WHERE digest=? AND revoked_at IS NULL",
      )
      .get(tokenDigest) as { worker_id: string } | undefined;
    db.prepare(
      "UPDATE worker_tokens SET revoked_at=? WHERE digest=? AND revoked_at IS NULL",
    ).run(now(), tokenDigest);
    if (row) {
      const c = connections.get(row.worker_id);
      if (c?.tokenDigest === tokenDigest) {
        offline(row.worker_id, c.epoch);
        c.socket.close(1008, "token revoked");
        connections.delete(row.worker_id);
      }
    }
    return { ok: true };
  });
  app.get(
    "/ws/worker",
    {
      preValidation: async (req, reply) => {
        const auth = req.headers.authorization;
        const tokenDigest = auth?.startsWith("Bearer ")
          ? digest(auth.slice(7))
          : undefined;
        const row = tokenDigest
          ? (db
              .prepare(
                "SELECT worker_id FROM worker_tokens WHERE digest=? AND revoked_at IS NULL",
              )
              .get(tokenDigest) as { worker_id: string } | undefined)
          : undefined;
        if (!row) return reply.code(401).send({ error: "unauthorized" });
        Object.assign(req, {
          workerId: row.worker_id,
          workerTokenDigest: tokenDigest,
        });
      },
      websocket: true,
    },
    (socket, req) => {
      const { workerId: id, workerTokenDigest } = req as typeof req & {
        workerId: string;
        workerTokenDigest: string;
      };
      let epoch = 0;
      let registerHash: string | undefined;
      let reacks: ReturnType<typeof coordinator.reconcile> = [];
      const registrationDeadline = setTimeout(
        () => socket.close(1008, "register timeout"),
        10000,
      );
      socket.on("message", (raw, isBinary) => {
        try {
          if (isBinary) throw new Error("binary_frame");
          const f = parseFrame(raw.toString());
          if (f.worker_id !== id) throw new Error("identity");
          if (f.type === "register") {
            if (epoch) {
              if (
                connections.get(id)?.socket !== socket ||
                requestHash(f) !== registerHash
              )
                throw new Error("conflicting_register");
              socket.send(
                stringifyFrame({
                  protocol_version: 1,
                  type: "register_ack",
                  worker_id: id,
                  connection_epoch: epoch,
                  reconciliation_required: true,
                } as WorkerFrame),
              );
              return;
            }
            if (
              !db
                .prepare(
                  "SELECT 1 FROM worker_tokens WHERE digest=? AND worker_id=? AND revoked_at IS NULL",
                )
                .get(workerTokenDigest, id)
            )
              throw new Error("token_revoked");
            const ids = new Set(f.workspaces.map((w) => w.workspace_id));
            if (
              ids.size !== f.workspaces.length ||
              f.workspaces.filter((w) => w.is_default).length !== 1
            )
              throw new Error("workspaces");
            epoch = db.transaction(() => {
              const slot = db
                .prepare(
                  "SELECT active_job_id FROM worker_slots WHERE worker_id=?",
                )
                .get(id) as { active_job_id: string | null } | undefined;
              const currentWorkspaces = db
                .prepare(
                  "SELECT workspace_id,config_version,path,repo_id,is_default FROM workspaces WHERE worker_id=? ORDER BY workspace_id",
                )
                .all(id) as Array<{
                workspace_id: string;
                config_version: number;
                path: string;
                repo_id: string;
                is_default: number;
              }>;
              const nextWorkspaces = [...f.workspaces]
                .sort((a, b) => a.workspace_id.localeCompare(b.workspace_id))
                .map((workspace) => ({
                  identity: [
                    workspace.workspace_id,
                    workspace.config_version,
                    workspace.path,
                    workspace.repo_id,
                    Number(workspace.is_default),
                  ],
                }));
              const currentIdentities = currentWorkspaces.map((workspace) => [
                workspace.workspace_id,
                workspace.config_version,
                workspace.path,
                workspace.repo_id,
                workspace.is_default,
              ]);
              const workspaceMapChanged =
                JSON.stringify(currentIdentities) !==
                JSON.stringify(nextWorkspaces.map(({ identity }) => identity));
              if (workspaceMapChanged && slot?.active_job_id != null)
                throw new Error("workspace_change_with_active_job");
              db.prepare(
                `INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES (?,?,?,1,1,0,0,?) ON CONFLICT(worker_id) DO UPDATE SET boot_id=excluded.boot_id,connection_epoch=workers.connection_epoch+1,online=1,reconciled=0,last_seen=excluded.last_seen,blocked=CASE WHEN workers.ledger_id<>excluded.ledger_id THEN 1 ELSE workers.blocked END,reported_ledger_id=CASE WHEN workers.ledger_id<>excluded.ledger_id THEN excluded.ledger_id ELSE NULL END`,
              ).run(id, f.boot_id, f.ledger_id, now());
              db.prepare(
                "INSERT OR IGNORE INTO worker_slots(worker_id) VALUES (?)",
              ).run(id);
              if (workspaceMapChanged)
                db.prepare("DELETE FROM workspaces WHERE worker_id=?").run(id);
              for (const w of f.workspaces)
                db.prepare(
                  "INSERT OR IGNORE INTO workspaces VALUES (?,?,?,?,?,?)",
                ).run(
                  id,
                  w.workspace_id,
                  w.config_version,
                  w.path,
                  w.repo_id,
                  Number(w.is_default),
                );
              return (
                db
                  .prepare(
                    "SELECT connection_epoch FROM workers WHERE worker_id=?",
                  )
                  .get(id) as { connection_epoch: number }
              ).connection_epoch;
            })();
            registerHash = requestHash(f);
            const old = connections.get(id);
            connections.set(id, {
              epoch,
              socket,
              tokenDigest: workerTokenDigest,
            });
            old?.socket.close(1008, "connection replaced");
            clearTimeout(registrationDeadline);
            socket.send(
              stringifyFrame({
                protocol_version: 1,
                type: "register_ack",
                worker_id: id,
                connection_epoch: epoch,
                reconciliation_required: true,
              } as WorkerFrame),
            );
            return;
          }
          if (
            !epoch ||
            connections.get(id)?.socket !== socket ||
            f.connection_epoch !== epoch
          )
            throw new Error("stale_epoch");
          if (f.type === "heartbeat")
            db.prepare(
              "UPDATE workers SET last_seen=? WHERE worker_id=? AND connection_epoch=?",
            ).run(now(), id, epoch);
          else if (f.type === "resume")
            socket.send(
              stringifyFrame({
                protocol_version: 1,
                type: "ack",
                worker_id: id,
                connection_epoch: epoch,
                ack_type: "resume",
              } as WorkerFrame),
            );
          else if (f.type === "reconcile") {
            const worker = db
              .prepare("SELECT ledger_id FROM workers WHERE worker_id=?")
              .get(id) as { ledger_id: string };
            if (f.ledger_id !== worker.ledger_id || !f.ready)
              throw new Error("reconcile_blocked");
            // Contradictions block the worker but keep it connected and visible.
            reacks = coordinator.reconcile(id, f.calls);
            db.prepare(
              "UPDATE workers SET reconciled=1 WHERE worker_id=? AND connection_epoch=?",
            ).run(id, epoch);
            socket.send(
              stringifyFrame({
                protocol_version: 1,
                type: "ack",
                worker_id: id,
                connection_epoch: epoch,
                ack_type: "reconcile",
              } as WorkerFrame),
            );
          } else if (f.type === "worker_ready") {
            if (!f.ready) throw new Error("worker_not_ready");
            db.prepare("UPDATE workers SET online=1,last_seen=? WHERE worker_id=? AND connection_epoch=? AND reconciled=1").run(now(),id,epoch);
            coordinator.resumeWorker(id, reacks);
            reacks = [];
          } else if (f.type === "tool_result" || f.type === "tool_rejected" || f.type === "tool_log" || f.type === "log_status" || f.type === "cancel_ack" || f.type === "resolve_ack") {
            coordinator.receive(f);
          } else if (f.type === "tool_accepted") {
            // Acceptance only proves the worker ledger owns the call; the result decides.
            mainFault("after_dispatch");
          } else throw new Error("unexpected_frame");
        } catch {
          if (epoch) offline(id, epoch);
          socket.close(1008, "invalid frame");
        }
      });
      socket.on("close", () => {
        clearTimeout(registrationDeadline);
        if (epoch) offline(id, epoch);
        if (connections.get(id)?.socket === socket) connections.delete(id);
      });
    },
  );
  const timer = setInterval(() => {
    for (const [id, c] of connections) {
      const row = db
        .prepare("SELECT last_seen FROM workers WHERE worker_id=?")
        .get(id) as { last_seen: number };
      if (now() - row.last_seen >= 30000) {
        offline(id, c.epoch);
        connections.delete(id);
        c.socket.close(1008, "heartbeat timeout");
      }
    }
  }, 1000);
  timer.unref();
  const expiryTimer=setInterval(()=>{
    db.prepare("UPDATE jobs SET state='failed',end_reason='worker_wait_expired' WHERE state='waiting_worker' AND wait_until IS NOT NULL AND wait_until<?").run(now());
    coordinator.sweepDeadlines();
  },options.waitSweepMs??60000);
  expiryTimer.unref();
  app.addHook("onClose", async () => {
    coordinator.close();
    clearInterval(timer);
    clearInterval(expiryTimer);
    for (const [id, c] of connections) offline(id, c.epoch);
    shuttingDown = true;
    for (const c of connections.values()) c.socket.terminate();
  });
  return app;
}
