// worker-plane-admin: offline and online maintenance of the main node's data.
//   backup <dest.sqlite>   online, while the main node runs
//   verify <file.sqlite>   integrity and the counts recovery depends on
//   restore <file.sqlite>  main node stopped; it restarts with dispatch paused
import { backup, inspect, restore } from "./ops.js";

const [command, file] = process.argv.slice(2);
const dataDir = process.env.DATA_DIR ?? "./data";
const usage = "usage: worker-plane-admin backup|verify|restore <file.sqlite>  (DATA_DIR selects the data directory)";
if (!command || !file) {
  console.error(usage);
  process.exit(2);
}
try {
  const result =
    command === "backup" ? await backup(dataDir, file)
    : command === "verify" ? inspect(file)
    : command === "restore" ? restore(dataDir, file)
    : undefined;
  if (!result) { console.error(usage); process.exit(2); }
  console.log(JSON.stringify(result, null, 2));
  if (result.integrity !== "ok") process.exit(1);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
