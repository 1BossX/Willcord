import { mkdirSync, chmodSync } from "node:fs";
import argon2 from "argon2";
import { openDatabase } from "./storage.js";
import { createApp } from "./app.js";
import { acquireOwnerLock } from "./lock.js";
const dir = process.env.DATA_DIR ?? "./data";
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
  const app = await createApp(
    db,
    process.env.PUBLIC_BASE_URL ?? "https://localhost:8443",
  );
  await app.listen({ host: "127.0.0.1", port: 3000 });
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
