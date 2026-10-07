import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(
  new URL("../packages/protocol/package.json", import.meta.url),
);
const { compile } = require("json-schema-to-typescript");
const schema = JSON.parse(
  readFileSync("packages/protocol/schema.json", "utf8"),
);
writeFileSync(
  "packages/protocol/src/generated.ts",
  await compile(schema, "WorkerFrame", {
    bannerComment: "/* Generated from schema.json. Do not edit. */",
  }),
);
// Rust derives its wire data fields from exactly the same schema.
const fieldType = (s) =>
  s.const !== undefined
    ? typeof s.const === "number"
      ? "u64"
      : typeof s.const === "boolean"
        ? "bool"
        : "String"
    : s.enum
      ? "String"
      : s.type === "integer"
        ? "u64"
        : s.type === "boolean"
          ? "bool"
          : s.type === "array"
            ? "Vec<Workspace>"
            : "String";
const workspace = schema.oneOf[0].properties.workspaces.items;
let rust =
  "// Generated from schema.json. Do not edit.\npub const MAX_FRAME_BYTES: usize = " +
  schema["x-max-frame-bytes"] +
  ";\nuse serde::{Serialize, Deserialize};\n";
for (const [name, props] of [
  ["Workspace", workspace.properties],
  ...schema.oneOf.map((s) => [
    s.properties.type.const
      .split("_")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(""),
    s.properties,
  ]),
]) {
  rust +=
    "#[derive(Clone, Debug, Serialize, Deserialize)]\n#[serde(deny_unknown_fields)]\npub struct " +
    name +
    " {\n";
  for (const [key, value] of Object.entries(props))
    rust +=
      (key === "type" ? '    #[serde(rename="type")]\n' : "") +
      "    pub " +
      (key === "type" ? "kind" : key) +
      ": " +
      fieldType(value) +
      ",\n";
  rust += "}\n";
}
writeFileSync("worker/src/generated.rs", rust);

execFileSync("rustfmt", ["--edition", "2024", "worker/src/generated.rs"]);
