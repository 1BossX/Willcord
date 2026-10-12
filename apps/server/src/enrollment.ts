import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const enrollmentPaths = new Set(["/enrollment/challenge", "/enrollment/apply", "/enrollment/credentials", "/enrollment/status", "/enrollment/workspace"]);
export function registerEnrollment(app: FastifyInstance, db: Database.Database, now: () => number, disconnect: (id: string) => void, publicBaseUrl: string) {
  const route = { bodyLimit: 4096, config: { rateLimit: { max: 30, timeWindow: 60000 } } };
  app.post("/enrollment/challenge", route, async () => {
    db.prepare("DELETE FROM enrollment_challenges WHERE expires_at<=?").run(now());
    if ((db.prepare("SELECT count(*) FROM enrollment_challenges").pluck().get() as number) >= 10000) throw Object.assign(new Error("challenge_capacity"),{statusCode:429});
    const challenge = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO enrollment_challenges VALUES (?,?)").run(challenge, now() + 300000);
    return { challenge, expires_in: 300 };
  });
  for (const action of ["apply", "credentials", "status", "workspace"] as const) {
    app.post(`/enrollment/${action}`, route, async (req, reply) => {
      const b = req.body as Record<string, unknown> | null;
      if (!b || typeof b.public_key !== "string" || typeof b.challenge !== "string" || typeof b.signature !== "string") return reply.code(400).send({ error: "invalid_proof" });
      let id: string;
      try {
        const raw = Buffer.from(b.public_key, "base64");
        const key = createPublicKey({ key: raw, type: "spki", format: "der" });
        if (key.asymmetricKeyType !== "ed25519" || !raw.equals(key.export({type:"spki",format:"der"}) as Buffer) || raw.toString("base64") !== b.public_key) throw Error();
        const payload = JSON.stringify(["willcord-enrollment-v1", action, b.challenge, b.public_key, action === "apply" ? b.name : null, action === "apply" ? b.os : null, action === "apply" ? b.arch : null]);
        if (!verify(null, Buffer.from(payload), key, Buffer.from(b.signature, "base64"))) throw Error();
        id = hash(raw);
      } catch { return reply.code(401).send({ error: "invalid_proof" }); }
      const result = db.transaction(() => {
        if (!db.prepare("DELETE FROM enrollment_challenges WHERE challenge=? AND expires_at>?").run(b.challenge, now()).changes) return { code: 401, data: { error: "expired_proof" } };
        let row = db.prepare("SELECT * FROM enrollments WHERE worker_id=?").get(id) as any;
        if (action === "apply") {
          if (![b.name, b.os, b.arch].every(v => typeof v === "string" && v.length > 0 && v.length <= 128)) return { code: 400, data: { error: "invalid_metadata" } };
          if (!row) {
            if (db.prepare("SELECT 1 FROM worker_tokens WHERE worker_id=? UNION ALL SELECT 1 FROM workers WHERE worker_id=? LIMIT 1").get(id,id)) return {code:409,data:{error:"legacy_device_requires_migration"}};
            if ((db.prepare("SELECT count(*) FROM enrollments WHERE state='pending'").pluck().get() as number) >= 1000) return {code:429,data:{error:"enrollment_capacity"}};
            db.prepare("INSERT INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?)").run(id, b.public_key, b.name, b.os, b.arch, now(), now());
            row = { state: "pending" };
          }
        }
        if (!row) return { code: 404, data: { error: "device_not_found" } };
        if (action === "workspace") {
          if (row.state !== "approved") return {code:403,data:{error:"device_not_approved"}};
          const slot = db.prepare("SELECT active_job_id FROM worker_slots WHERE worker_id=?").get(id) as any;
          if (slot?.active_job_id) return {code:409,data:{error:"worker_busy"}};
          disconnect(id);
          return {code:200,data:{ok:true}};
        }
        if (action !== "credentials") {
          const worker = db.prepare("SELECT online,reconciled,blocked FROM workers WHERE worker_id=?").get(id) ?? {};
          return { code: 200, data: { worker_id: id, state: row.state, ...worker as object } };
        }
        if (row.state !== "approved") return { code: 403, data: { error: "device_not_approved", state: row.state } };
        // A confirmed credential cannot be remotely rotated by a repeated claim.
        if (row.confirmed_digest && db.prepare("SELECT 1 FROM worker_tokens WHERE digest=? AND revoked_at IS NULL").get(row.confirmed_digest)) return { code: 409, data: { error: "credential_already_confirmed" } };
        if (row.pending_digest) db.prepare("UPDATE worker_tokens SET revoked_at=? WHERE digest=?").run(now(), row.pending_digest);
        const token = randomBytes(32).toString("base64url");
        db.prepare("INSERT INTO worker_tokens VALUES (?,?,NULL)").run(hash(token), id);
        db.prepare("UPDATE enrollments SET pending_digest=? WHERE worker_id=?").run(hash(token), id);
        return { code: 200, data: { worker_id: id, token, state: "approved" } };
      })();
      return reply.code(result.code).send(result.data);
    });
  }
  app.get("/api/enrollments", async () => ({ public_url: new URL(publicBaseUrl).origin, devices: (db.prepare("SELECT e.worker_id,e.name,e.os,e.arch,e.state,e.created_at,e.updated_at,w.online,w.reconciled,w.blocked,s.active_job_id FROM enrollments e LEFT JOIN workers w USING(worker_id) LEFT JOIN worker_slots s USING(worker_id) ORDER BY e.created_at DESC").all() as any[]).map(d=>({...d,workspaces:db.prepare("SELECT workspace_id,path,is_default FROM workspaces WHERE worker_id=?").all(d.worker_id)})) }));
  app.patch<{Params:{id:string}}>("/api/enrollments/:id",async(req,reply)=>{
    const name=(req.body as {name?:unknown}|null)?.name;
    if(typeof name!=="string" || !name.trim() || name.length>128) return reply.code(400).send({error:"invalid_metadata"});
    if(!db.prepare("UPDATE enrollments SET name=?,updated_at=? WHERE worker_id=?").run(name.trim(),now(),req.params.id).changes) return reply.code(404).send({error:"device_not_found"});
    return {ok:true};
  });
  for (const [action, state] of [["approve", "approved"], ["reject", "rejected"], ["revoke", "revoked"]] as const) {
    app.post<{ Params: { id: string } }>(`/api/enrollments/:id/${action}`, async (req, reply) => {
      const changed = db.transaction(() => {
        if (!db.prepare("SELECT 1 FROM enrollments WHERE worker_id=?").get(req.params.id)) return false;
        db.prepare("UPDATE enrollments SET state=?,updated_at=? WHERE worker_id=?").run(state, now(), req.params.id);
        if (state !== "approved") db.prepare("UPDATE worker_tokens SET revoked_at=? WHERE worker_id=? AND revoked_at IS NULL").run(now(), req.params.id);
        db.prepare("INSERT INTO events(created_at,content_json) VALUES (?,?)").run(now(), JSON.stringify({ type: "device_authorization", worker_id: req.params.id, action }));
        return true;
      })();
      if (!changed) return reply.code(404).send({ error: "device_not_found" });
      if (state !== "approved") disconnect(req.params.id);
      return { ok: true };
    });
  }
}
