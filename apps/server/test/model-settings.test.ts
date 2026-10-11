import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
import { resolveModel } from "../src/model-settings.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const ORIGIN = "https://localhost:8443";
// Deliberately unlike a real provider key, so secret scanners stay quiet.
const SECRET = `fixture-${"ab".repeat(12)}`;
const REPLACEMENT = `fixture-${"cd".repeat(12)}`;

async function fixture(env = { provider: "openrouter", name: "deepseek/deepseek-v4.1-flash", apiKey: "env-key-aaaaaaaa" as string | undefined }) {
  const dir = mkdtempSync(join(tmpdir(), "wp-model-"));
  const db = openDatabase(":memory:");
  const probed: Array<{ provider: string; name: string; apiKey: string }> = [];
  let probeResult = { ok: true, message: "ok" };
  const app = await createApp(db, ORIGIN, { logging: false, dataDir: dir, model: env, modelProbe: async (m) => { probed.push(m); return probeResult; } });
  db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(hash("admin"), "csrf", 1e13);
  const headers = { cookie: "session=admin", origin: ORIGIN, "x-csrf-token": "csrf" };
  const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}), headers });
  return { dir, db, app, env, call, probed, setProbe: (r: { ok: boolean; message: string }) => { probeResult = r; }, close: async () => { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("model settings need a login and a CSRF token", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ method: "GET", url: "/api/settings/model" })).statusCode, 401);
    const noCsrf = await f.app.inject({ method: "PUT", url: "/api/settings/model", payload: { name: "x" }, headers: { cookie: "session=admin", origin: ORIGIN } });
    assert.equal(noCsrf.statusCode, 403);
  } finally { await f.close(); }
});

test("the console's model choice overrides the environment, the key is encrypted and never returned", async () => {
  const f = await fixture();
  try {
    const before = (await f.call("GET", "/api/settings/model")).json();
    assert.deepEqual([before.source, before.provider, before.has_key], ["environment", "openrouter", true]);
    assert.ok(before.providers.includes("openrouter") && before.providers.includes("anthropic"));

    const saved = await f.call("PUT", "/api/settings/model", { provider: "openrouter", name: "deepseek/deepseek-v4.1-flash", api_key: SECRET });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.doesNotMatch(saved.body, new RegExp(SECRET));
    assert.equal(saved.json().source, "console");
    assert.equal(saved.json().key_hint, "…abab");
    assert.equal(resolveModel(f.db, f.dir, f.env).apiKey, SECRET, "new jobs use the stored key");

    const row = f.db.prepare("SELECT * FROM model_settings").get() as any;
    assert.doesNotMatch(JSON.stringify(row), new RegExp(SECRET), "not stored in the clear");
    assert.match(row.api_key_enc, /^v1\./);
    assert.equal(statSync(join(f.dir, "model-secret.key")).mode & 0o777, 0o600);

    // Changing only the model keeps the key.
    const renamed = await f.call("PUT", "/api/settings/model", { name: "anthropic/claude-fable-5" });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.deepEqual([resolveModel(f.db, f.dir, f.env).name, resolveModel(f.db, f.dir, f.env).apiKey], ["anthropic/claude-fable-5", SECRET]);

    // Removing the override returns to the environment.
    const reset = (await f.call("DELETE", "/api/settings/model")).json();
    assert.deepEqual([reset.source, reset.name], ["environment", "deepseek/deepseek-v4.1-flash"]);
  } finally { await f.close(); }
});

test("a provider change requires its own key; the environment key is never borrowed across providers", async () => {
  const f = await fixture();
  try {
    const anthropic = (await import("@earendil-works/pi-ai/compat")).getModels("anthropic" as any)[0].id;
    const refused = await f.call("PUT", "/api/settings/model", { provider: "anthropic", name: anthropic });
    assert.deepEqual([refused.statusCode, refused.json().error], [400, "api_key_required"]);
    assert.equal(f.db.prepare("SELECT count(*) FROM model_settings").pluck().get(), 0);
    assert.equal((await f.call("PUT", "/api/settings/model", { provider: "anthropic", name: anthropic, api_key: SECRET })).statusCode, 200);
    // Back to the environment's provider without a key: the stored anthropic key must not follow.
    const back = await f.call("PUT", "/api/settings/model", { provider: "openrouter", name: "deepseek/deepseek-v4.1-flash" });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(resolveModel(f.db, f.dir, f.env).apiKey, "env-key-aaaaaaaa");
  } finally { await f.close(); }
});

test("invalid input is refused with a reason", async () => {
  const f = await fixture();
  try {
    for (const [body, error] of [
      [{ provider: "nope", name: "x", api_key: "k" }, "unknown_provider"],
      [{ provider: "openrouter", name: "no/such-model", api_key: "k" }, "unknown_model"],
      [{ name: "" }, "invalid_model"],
      [{ api_key: "line\nbreak" }, "invalid_api_key"],
    ] as const) {
      const r = await f.call("PUT", "/api/settings/model", body);
      assert.deepEqual([r.statusCode, r.json().error], [400, error], JSON.stringify(body));
    }
    assert.equal(f.db.prepare("SELECT count(*) FROM model_settings").pluck().get(), 0);
    assert.equal((await f.call("GET", "/api/settings/model/models?provider=nope")).statusCode, 400);
    assert.ok((await f.call("GET", "/api/settings/model/models?provider=openrouter")).json().models.includes("deepseek/deepseek-v4.1-flash"));
  } finally { await f.close(); }
});

test("the connection test uses the candidate without saving it", async () => {
  const f = await fixture();
  try {
    f.setProbe({ ok: false, message: "401: Missing Authentication header" });
    const bad = (await f.call("POST", "/api/settings/model/test", { api_key: "wrong" })).json();
    assert.deepEqual(bad, { ok: false, message: "401: Missing Authentication header" });
    assert.deepEqual(f.probed[0], { provider: "openrouter", name: "deepseek/deepseek-v4.1-flash", apiKey: "wrong" });
    assert.equal(f.db.prepare("SELECT count(*) FROM model_settings").pluck().get(), 0, "testing saves nothing");
    f.setProbe({ ok: true, message: "ok" });
    await f.call("POST", "/api/settings/model/test", {});
    assert.equal(f.probed[1].apiKey, "env-key-aaaaaaaa", "no key sent: the one in effect is tested");
  } finally { await f.close(); }
});

test("a database restored without its key file asks for the key again instead of failing jobs obscurely", async () => {
  const f = await fixture({ provider: "openrouter", name: "deepseek/deepseek-v4.1-flash", apiKey: undefined });
  try {
    await f.call("PUT", "/api/settings/model", { api_key: SECRET });
    rmSync(join(f.dir, "model-secret.key"));
    const view = (await f.call("GET", "/api/settings/model")).json();
    assert.deepEqual([view.has_key, view.key_unreadable], [false, true]);
    assert.equal(resolveModel(f.db, f.dir, f.env).apiKey, undefined);
  } finally { await f.close(); }
});

test("an unreadable stored key must be replaced: neither save nor test falls back to the environment key", async () => {
  const f = await fixture();
  try {
    await f.call("PUT", "/api/settings/model", { api_key: SECRET });
    rmSync(join(f.dir, "model-secret.key"));
    for (const [method, url] of [["PUT", "/api/settings/model"], ["POST", "/api/settings/model/test"]] as const) {
      const r = await f.call(method, url, { name: "anthropic/claude-fable-5" });
      assert.deepEqual([r.statusCode, r.json().error], [400, "api_key_required"], url);
    }
    assert.equal(f.probed.length, 0);
    const fixed = await f.call("PUT", "/api/settings/model", { api_key: REPLACEMENT });
    assert.equal(fixed.statusCode, 200, fixed.body);
    assert.equal(fixed.json().key_unreadable, false);
    assert.equal(resolveModel(f.db, f.dir, f.env).apiKey, REPLACEMENT);
  } finally { await f.close(); }
});
