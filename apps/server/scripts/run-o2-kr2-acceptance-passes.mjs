#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "test/o2-kr2-approved-action.test.ts"],
  { cwd: root, stdio: "inherit", env: { ...process.env } },
);
process.exit(result.status ?? 1);
