import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `willcord main init` rejects a mistyped provider before anything is written,
// so its list must name exactly what the model library accepts.
test("the wizard's provider list matches the model library", async () => {
  const file = readFileSync(fileURLToPath(new URL("../../../deploy/providers.txt", import.meta.url)), "utf8");
  const listed = file.split(/\s+/).filter(Boolean).sort();
  const ai = await import("@earendil-works/pi-ai/compat");
  assert.deepEqual(listed, [...(ai.getProviders() as string[])].sort(), "update deploy/providers.txt");
});
