import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The wizard in deploy/install.sh rejects a mistyped provider before anything is
// written, so its list must name exactly what the model library accepts.
test("the installer's provider list matches the model library", async () => {
  const script = readFileSync(fileURLToPath(new URL("../../../deploy/install.sh", import.meta.url)), "utf8");
  const listed = script.match(/^PROVIDERS="([^"]+)"$/m)?.[1].split(" ").sort();
  const ai = await import("@earendil-works/pi-ai/compat");
  assert.deepEqual(listed, [...(ai.getProviders() as string[])].sort(), "update PROVIDERS in deploy/install.sh");
});
