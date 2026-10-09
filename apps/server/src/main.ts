import { mkdirSync, chmodSync, readFileSync } from "node:fs";
import argon2 from "argon2";
import { openDatabase } from "./storage.js";
import { createApp } from "./app.js";
import { acquireOwnerLock } from "./lock.js";
import { loadConfig } from "./config.js";
const config = loadConfig(process.env);
const dir = config.dataDir;
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const release = acquireOwnerLock(dir);
let db: ReturnType<typeof openDatabase> | undefined;
try {
  db = openDatabase(`${dir}/main.sqlite`);
  if (!db.prepare("SELECT 1 FROM administrators").get()) {
    const password = process.env.INITIAL_ADMIN_PASSWORD;
    if (!password || password.length < 16)
      throw new Error(
        "INITIAL_ADMIN_PASSWORD (at least 16 characters) required for first start",
      );
    db.prepare("INSERT INTO administrators VALUES (1,?)").run(
      await argon2.hash(password, { type: argon2.argon2id }),
    );
  }
  delete process.env.INITIAL_ADMIN_PASSWORD;
  // Fault acceptance runs this process with scripted model turns keyed by the user message.
  const scripts = config.scriptFile ? JSON.parse(readFileSync(config.scriptFile, "utf8")) : undefined;
  const app = await createApp(db, config.publicBaseUrl, {
    dataDir: dir,
    model: config.model,
    ...(scripts ? { fakeScript: (job: any) => scripts[job.input_text] } : {}),
    ...(config.logCapacityBytes !== undefined ? { logCapacityBytes: config.logCapacityBytes } : {}),
    budget: config.budget,
    retentionMs: config.retentionDays * 24 * 3600 * 1000,
    minFreeBytes: config.minFreeBytes,
  });
  await app.listen({ host: "127.0.0.1", port: config.port });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().then(() => {
        db!.close();
        release();
        process.exit(0);
      });
    });
} catch (error) {
  db?.close();
  release();
  throw error;
}
