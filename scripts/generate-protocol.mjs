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
            ? `Vec<${s.items.title ?? "Workspace"}>`
            : s.type === "object"
              ? "Value"
            : "String";
const workspace = schema.oneOf[0].properties.workspaces.items;
const nested = schema.oneOf.flatMap((frame) =>
  Object.values(frame.properties)
    .filter((p) => p.type === "array" && p.items.title)
    .map((p) => [p.items.title, p.items.properties]),
);
let rust =
  "// Generated from schema.json. Do not edit.\npub const MAX_FRAME_BYTES: usize = " +
  schema["x-max-frame-bytes"] +
  ";\nuse serde::{Serialize, Deserialize};\nuse serde_json::Value;\n";
for (const [name, props, required] of [
  ["Workspace", workspace.properties, new Set(schema.oneOf[0].properties.workspaces.items.required ?? Object.keys(workspace.properties))],
  ...nested.map(([n, p]) => [n, p, new Set(Object.keys(p))]),
  ...schema.oneOf.map((s) => [
    s.properties.type.const
      .split("_")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(""),
    s.properties,
    new Set(s.required),
  ]),
]) {
  rust +=
    "#[derive(Clone, Debug, Serialize, Deserialize)]\n#[serde(deny_unknown_fields)]\npub struct " +
    name +
    " {\n";
  for (const [key, value] of Object.entries(props)) {
    const optional = !required.has(key);
    const ty = fieldType(value);
    if (key === "type") rust += '    #[serde(rename="type")]\n';
    if (key === "final") rust += '    #[serde(rename="final")]\n';
    if (optional) rust += '    #[serde(default, skip_serializing_if = "Option::is_none")]\n';
    rust +=
      "    pub " +
      (key === "type" ? "kind" : key === "final" ? "is_final" : key) +
      ": " +
      (optional ? `Option<${ty}>` : ty) +
      ",\n";
  }
  rust += "}\n";
}
writeFileSync("worker/src/generated.rs", rust);

execFileSync("rustfmt", ["--edition", "2024", "worker/src/generated.rs"]);
