import Fastify from "fastify";
import type { FastifyLoggerOptions } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import argon2 from "argon2";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ExecutionCoordinator, newJobId } from "./execution.js";
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
  const coordinator = new ExecutionCoordinator(db, connections, now, options.runJob as ((job:any)=>Promise<void>)|undefined);
  let shuttingDown = false;
  const offline = (id: string, epoch: number) => {
    if (shuttingDown) return;
    return db
      .prepare(
        "UPDATE workers SET online=0,reconciled=0 WHERE worker_id=? AND connection_epoch=?",
      )
      .run(id, epoch);
  };
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
    scheduling_ready: true,
    phase: "P2",
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
  app.get("/api/workers", async () =>
    db.prepare("SELECT w.*,s.active_job_id FROM workers w LEFT JOIN worker_slots s USING(worker_id) ORDER BY w.worker_id").all(),
  );
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
  app.get<{Params:{session_id:string}}>("/api/sessions/:session_id/messages",async(req,reply)=>{
    if(!db.prepare("SELECT 1 FROM sessions WHERE session_id=?").get(req.params.session_id)) return reply.code(404).send({error:"session_not_found"});
    return db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY seq").all(req.params.session_id);
  });
  app.get<{Params:{session_id:string}}>("/api/sessions/:session_id/jobs",async(req,reply)=>{
    if(!db.prepare("SELECT 1 FROM sessions WHERE session_id=?").get(req.params.session_id)) return reply.code(404).send({error:"session_not_found"});
    return db.prepare(`SELECT j.job_id,j.worker_id,j.client_request_id,j.input_text,j.state,j.queue_seq,j.created_at,j.started_at,j.wait_until,
      CASE WHEN j.state IN ('queued','waiting_worker') THEN (SELECT COUNT(*) FROM jobs q WHERE q.worker_id=j.worker_id AND q.state IN ('queued','waiting_worker') AND q.queue_seq<=j.queue_seq) ELSE NULL END AS queue_position
      FROM jobs j WHERE j.session_id=? ORDER BY j.queue_seq`).all(req.params.session_id);
  });
  app.post<{Params:{session_id:string}}>("/api/sessions/:session_id/messages",async(req,reply)=>{
    const body=req.body as {client_request_id?:unknown;message?:unknown}|null;
    if(typeof body?.client_request_id!=="string"||!body.client_request_id||body.client_request_id.length>128||typeof body.message!=="string"||!body.message.trim()||body.message.length>32000) return reply.code(400).send({error:"invalid_message"});
    const session=db.prepare("SELECT * FROM sessions WHERE session_id=?").get(req.params.session_id) as any;
    if(!session) return reply.code(404).send({error:"session_not_found"});
    const requestHash=digest(JSON.stringify({message:body.message}));
    const waitMs=Number(process.env.WORKER_WAIT_MS??86400000);
    const outcome=db.transaction(()=>{
      const existing=db.prepare("SELECT job_id,request_hash,state FROM jobs WHERE session_id=? AND client_request_id=?").get(session.session_id,body.client_request_id) as any;
      if(existing) return existing.request_hash===requestHash?{existing:true,conflict:false,job_id:existing.job_id,state:existing.state}:{existing:true,conflict:true};
      const worker=db.prepare("SELECT * FROM workers WHERE worker_id=?").get(session.worker_id) as any;
      const waiting=(worker?.online&&worker?.reconciled&&!worker?.blocked)?"queued":"waiting_worker";
      const jobId=newJobId(),queueSeq=Number((db.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 n FROM jobs").get() as any).n);
      db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at,wait_until) VALUES(?,?,?,?,?,?,?,?,?,?)").run(jobId,session.session_id,body.client_request_id,requestHash,body.message,session.worker_id,queueSeq,waiting,now(),now()+waitMs);
      db.prepare("INSERT INTO messages(message_id,session_id,job_id,seq,content_json) SELECT ?,?,?,COALESCE(MAX(seq),0)+1,? FROM messages WHERE session_id=?").run(randomBytes(16).toString("hex"),session.session_id,jobId,JSON.stringify({role:"user",content:body.message}),session.session_id);
      db.prepare("INSERT INTO worker_slots(worker_id) VALUES (?) ON CONFLICT(worker_id) DO NOTHING").run(session.worker_id);
      return {existing:false,conflict:false,job_id:jobId,state:waiting};
    }).immediate();
    if(outcome.conflict) return reply.code(409).send({error:"idempotency_conflict"});
    if(outcome.existing) return outcome;
    if(outcome.state==="queued") void coordinator.pump(session.worker_id);
    return reply.code(202).send({job_id:outcome.job_id,state:outcome.state});
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
                `INSERT INTO workers VALUES (?,?,?,1,1,0,0,?) ON CONFLICT(worker_id) DO UPDATE SET boot_id=excluded.boot_id,connection_epoch=workers.connection_epoch+1,online=1,reconciled=0,last_seen=excluded.last_seen,blocked=CASE WHEN workers.ledger_id<>excluded.ledger_id THEN 1 ELSE workers.blocked END`,
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
              .prepare(
                "SELECT ledger_id,blocked FROM workers WHERE worker_id=?",
              )
              .get(id) as { ledger_id: string; blocked: number };
            const slot = db
              .prepare(
                "SELECT active_job_id FROM worker_slots WHERE worker_id=?",
              )
              .get(id) as { active_job_id: string | null };
            if (
              f.ledger_id !== worker.ledger_id ||
              worker.blocked ||
              slot.active_job_id !== null ||
              !f.ready
            )
              throw new Error("reconcile_blocked");
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
            db.prepare("UPDATE workers SET reconciled=1,online=1,last_seen=? WHERE worker_id=? AND connection_epoch=?").run(now(),id,epoch);
            void coordinator.pump(id);
          } else if (f.type === "tool_result" || f.type === "tool_rejected") {
            coordinator.receive(f);
          } else if (f.type === "tool_accepted") {
            // Acceptance only proves the worker ledger owns the call; the result decides.
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
    db.prepare("UPDATE jobs SET state='failed' WHERE state='waiting_worker' AND wait_until IS NOT NULL AND wait_until<?").run(now());
  },60000);
  expiryTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    clearInterval(expiryTimer);
    for (const [id, c] of connections) offline(id, c.epoch);
    shuttingDown = true;
    for (const c of connections.values()) c.socket.terminate();
  });
  return app;
}
