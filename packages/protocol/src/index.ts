import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { WorkerFrame } from "./generated.js";
const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const canonicalize = require("canonicalize");
const validator = new Ajv({ strict: true }).compile(
  JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8")),
);
export const MAX_FRAME_BYTES = 65536;
export function parseFrame(text: string): WorkerFrame {
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES)
    throw new Error("frame_too_large");
  const value: unknown = JSON.parse(text);
  if (!validator(value)) throw new Error("invalid_frame");
  return value as WorkerFrame;
}
export function requestHash(request: unknown): string {
  const normalized = canonicalize(request);
  if (typeof normalized !== "string") throw new Error("invalid_request");
  return createHash("sha256").update(normalized).digest("hex");
}
export function normalizeRepo(remote: string): string {
  const value = remote.trim().replace(/^git@([^:]+):/, "https://$1/");
  const url = new URL(value);
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.search ||
    url.hash ||
    url.port
  )
    throw new Error("invalid_remote");
  return `${url.hostname.toLowerCase()}/${url.pathname
    .replace(/^\//, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "")}`;
}
export type { WorkerFrame };
