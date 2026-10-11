import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { ModelConfig } from "./config.js";

export type ModelTestResult = { ok: boolean; message: string };
/** Ask the provider for one tiny completion; tests replace it so no network is used. */
export type ModelProbe = (model: { provider: string; name: string; apiKey: string }) => Promise<ModelTestResult>;

type Row = { provider: string; name: string; api_key_enc: string | null; key_hint: string | null; updated_at: number };

const KEY_FILE = "model-secret.key";
const tail = (key: string) => (key.length >= 8 ? `…${key.slice(-4)}` : "");

/** AES-256-GCM under a random key beside the database; created on first use, owner-only. */
function secretKey(dataDir: string, create: boolean): Buffer | null {
  const path = resolve(dataDir, KEY_FILE);
  if (existsSync(path)) return readFileSync(path);
  if (!create) return null;
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return key;
}
function seal(key: Buffer, plain: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), body].map((p) => (typeof p === "string" ? p : p.toString("base64"))).join(".");
}
function open(key: Buffer, sealed: string): string | null {
  try {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== "v1") return null;
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch { return null; }
}

const stored = (db: Database.Database) => db.prepare("SELECT * FROM model_settings WHERE id=1").get() as Row | undefined;

/**
 * The model new jobs use. The console's choice wins over the environment, which
 * stays the first-run default. An environment key is borrowed only for the
 * provider it was written for.
 */
export function resolveModel(db: Database.Database, dataDir: string, env: ModelConfig): ModelConfig {
  const row = stored(db);
  if (!row) return env;
  const key = secretKey(dataDir, false);
  const apiKey = (row.api_key_enc && key ? open(key, row.api_key_enc) : null) ?? (row.provider === env.provider ? env.apiKey : undefined);
  return { provider: row.provider, name: row.name, apiKey };
}

export function modelView(db: Database.Database, dataDir: string, env: ModelConfig) {
  const row = stored(db), effective = resolveModel(db, dataDir, env);
  const key = secretKey(dataDir, false);
  const unreadable = Boolean(row?.api_key_enc) && !(key && open(key, row!.api_key_enc!));
  return {
    provider: effective.provider,
    name: effective.name,
    has_key: Boolean(effective.apiKey),
    key_hint: row?.api_key_enc && !unreadable ? row.key_hint : effective.apiKey && !row ? tail(effective.apiKey) : null,
    source: row ? "console" : "environment",
    // A restored database without its key file: re-enter the key.
    key_unreadable: unreadable,
    updated_at: row?.updated_at ?? null,
  };
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length >= 1 && v.trim().length <= max && !/[\u0000-\u001f]/.test(v) ? v.trim() : null);

export function registerModelSettings(
  app: FastifyInstance, db: Database.Database, now: () => number,
  options: { dataDir: string; env: ModelConfig; probe: ModelProbe },
) {
  const route = { bodyLimit: 16384 };
  const catalog = async () => {
    const ai = await import("@earendil-works/pi-ai/compat");
    return ai;
  };
  app.get("/api/settings/model", async () => ({ ...modelView(db, options.dataDir, options.env), providers: (await catalog()).getProviders() }));
  app.get<{ Querystring: { provider?: string } }>("/api/settings/model/models", async (req, reply) => {
    const provider = text(req.query.provider, 64);
    const ai = await catalog();
    if (!provider || !(ai.getProviders() as string[]).includes(provider)) return reply.code(400).send({ error: "unknown_provider" });
    return { models: (ai.getModels(provider as any) as Array<{ id: string }>).map((m) => m.id) };
  });
  /** Validate a candidate; its key is the one sent, else the one already in effect for the same provider. */
  async function candidate(body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const current = resolveModel(db, options.dataDir, options.env);
    const provider = b.provider === undefined ? current.provider : text(b.provider, 64);
    const name = b.name === undefined ? current.name : text(b.name, 200);
    if (!provider || !name) return { ok: false as const, error: "invalid_model" as const };
    const ai = await catalog();
    if (!(ai.getProviders() as string[]).includes(provider)) return { ok: false as const, error: "unknown_provider" as const };
    if (!ai.getModel(provider as any, name as any)) return { ok: false as const, error: "unknown_model" as const };
    let apiKey: string | undefined;
    if (b.api_key !== undefined && b.api_key !== "") {
      apiKey = text(b.api_key, 4096) ?? undefined;
      if (!apiKey) return { ok: false as const, error: "invalid_api_key" as const };
    } else if (provider === current.provider) apiKey = current.apiKey;
    else if (provider === options.env.provider) apiKey = options.env.apiKey;
    if (!apiKey) return { ok: false as const, error: "api_key_required" as const };
    return { ok: true as const, provider, name, apiKey, sentKey: b.api_key !== undefined && b.api_key !== "" };
  }
  const status = (error: string) => (error === "api_key_required" || error.startsWith("invalid") || error.startsWith("unknown") ? 400 : 500);
  app.post("/api/settings/model/test", route, async (req, reply) => {
    const c = await candidate(req.body);
    if (!c.ok) return reply.code(status(c.error)).send({ error: c.error });
    return options.probe({ provider: c.provider, name: c.name, apiKey: c.apiKey });
  });
  app.put("/api/settings/model", route, async (req, reply) => {
    const c = await candidate(req.body);
    if (!c.ok) return reply.code(status(c.error)).send({ error: c.error });
    const row = stored(db);
    // Keep the stored ciphertext when the key is unchanged; an environment key is never copied into the database.
    let enc = row?.api_key_enc ?? null, hint = row?.key_hint ?? null;
    if (c.sentKey) { enc = seal(secretKey(options.dataDir, true)!, c.apiKey); hint = tail(c.apiKey); }
    else if (row && row.provider !== c.provider) { enc = null; hint = null; }
    db.prepare("INSERT INTO model_settings(id,provider,name,api_key_enc,key_hint,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,name=excluded.name,api_key_enc=excluded.api_key_enc,key_hint=excluded.key_hint,updated_at=excluded.updated_at").run(c.provider, c.name, enc, hint, now());
    return modelView(db, options.dataDir, options.env);
  });
  app.delete("/api/settings/model", async () => {
    db.prepare("DELETE FROM model_settings WHERE id=1").run();
    return modelView(db, options.dataDir, options.env);
  });
}

/** One-token completion through the same SDK jobs use, so a pass means jobs will reach the model. */
export const piProbe: ModelProbe = async ({ provider, name, apiKey }) => {
  const ai = await import("@earendil-works/pi-ai/compat");
  const model = ai.getModel(provider as any, name as any);
  if (!model) return { ok: false, message: "unknown_model" };
  try {
    const reply = await ai.completeSimple(model, { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, { apiKey, maxTokens: 16, signal: AbortSignal.timeout(20000) });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") return { ok: false, message: reply.errorMessage ?? reply.stopReason };
    return { ok: true, message: "ok" };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
};
