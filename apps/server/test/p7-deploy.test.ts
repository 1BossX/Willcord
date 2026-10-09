// P7-B: worker settings a deployment relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptStep } from "../src/execution.js";
import { startScenario } from "./support/main-node.js";

const bash = (id: string, command: string): ScriptStep[] => [{ tool: "bash", arguments: { command }, id }, { text: `${id} done` }];

test("P7-B command_path sets the PATH commands run with; a relative entry is refused at start", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: { probe: bash("probe-1", "wp-probe >> marker.log; echo \"$PATH\" >> marker.log") } });
  try {
    // A tool installed outside the default PATH, as Homebrew is on Apple Silicon.
    const tools = join(s.dir, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "wp-probe"), "#!/bin/sh\necho probed\n");
    chmodSync(join(tools, "wp-probe"), 0o755);
    const path = `${tools}:/usr/bin:/bin`;

    const refused = s.startWorker({ extraConfig: `command_path = "tools:/usr/bin"\n` });
    await refused.exited;
    assert.equal(refused.child.exitCode, 1);
    assert.match(refused.stderr(), /command_path must list absolute directories/);

    s.startWorker({ extraConfig: `command_path = "${path}"\n` });
    await s.ready();
    const job = await s.submit(await s.createSession(), "probe");
    await s.until(() => s.state(job) === "succeeded");
    assert.equal(s.count("probed"), 1);
    assert.equal(s.count(path), 1, "the command saw exactly the configured PATH");
  } finally { await s.close(); }
});
