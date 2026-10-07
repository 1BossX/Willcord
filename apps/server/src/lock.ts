import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Fail closed after an unclean exit. An operator verifies the old process is gone
// before removing this directory; elapsed wall-clock time cannot steal ownership.
export function acquireOwnerLock(dir: string) {
  const path = join(dir, "main.lock");
  mkdirSync(path, { mode: 0o700 });
  writeFileSync(
    join(path, "owner.json"),
    JSON.stringify({ pid: process.pid, started_at: Date.now() }),
    { mode: 0o600 },
  );
  return () => rmSync(path, { recursive: true });
}
