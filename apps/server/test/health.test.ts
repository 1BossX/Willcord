import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
const health = async (app: Awaited<ReturnType<typeof createApp>>) =>
  (await app.inject({ method: "GET", url: "/health" })).json();
test("health separates liveness from scheduling readiness", async () => {
  const db = openDatabase(":memory:");
  const app = await createApp(db, "https://localhost:8443", { logging: false });
  assert.deepEqual(await health(app), { alive: true, scheduling_ready: false, phase: "P6" }, "not ready before the startup recovery pass");
  await new Promise((r) => setImmediate(r));
  assert.equal((await health(app)).scheduling_ready, true, "ready once recovery ran and the database answers");
  db.close();
  assert.deepEqual(await health(app), { alive: true, scheduling_ready: false, phase: "P6" }, "an unusable database is not ready");
  await app.close();
});
