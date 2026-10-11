import type { Budget } from "./execution.js";

export type ModelConfig = { provider: string; name: string; apiKey: string | undefined };

export type MainConfig = {
  dataDir: string;
  /** Listen address; 127.0.0.1 behind a local Caddy, 0.0.0.0 inside a container. */
  host: string;
  port: number;
  publicBaseUrl: string;
  logCapacityBytes?: number;
  budget: Partial<Budget>;
  model: ModelConfig;
  /** Scripted model turns keyed by the user message (fault acceptance and walkthroughs). */
  scriptFile?: string;
  /** Terminal jobs older than this lose their stored output chunks. */
  retentionDays: number;
  /** Below this much free space in the data directory, dispatch pauses. */
  minFreeBytes: number;
};

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MIN_FREE_BYTES = 1024 ** 3;

/** The model a real run uses; keys are only ever read from the environment. */
export function modelFromEnv(env: NodeJS.ProcessEnv): ModelConfig {
  return {
    provider: env.MODEL_PROVIDER ?? "openrouter",
    name: env.MODEL_NAME ?? "deepseek/deepseek-v4.1-flash",
    apiKey: env.MODEL_API_KEY ?? env.OPENROUTER_API_KEY,
  };
}

/**
 * Every setting of the main node, checked before anything starts. All problems
 * are reported together; secret values never appear in the message.
 */
export function loadConfig(env: NodeJS.ProcessEnv): MainConfig {
  const errors: string[] = [];
  const int = (name: string, min: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min) { errors.push(`${name} must be an integer >= ${min}`); return undefined; }
    return value;
  };
  const publicBaseUrl = env.PUBLIC_BASE_URL ?? "https://localhost:8443";
  try {
    if (new URL(publicBaseUrl).protocol !== "https:") errors.push("PUBLIC_BASE_URL must be an https URL");
  } catch { errors.push("PUBLIC_BASE_URL must be an https URL"); }
  const host = env.HOST || "127.0.0.1";
  if (!/^[0-9a-fA-F.:]+$/.test(host)) errors.push("HOST must be an IP address");
  const port = int("PORT", 1) ?? 3000;
  if (port > 65535) errors.push("PORT must be <= 65535");
  const scriptFile = env.P3_FAKE_SCRIPT_FILE || undefined;
  // The key is optional here: the console's "模型连接" can bind it after the first start.
  const model = modelFromEnv(env);
  const logCapacityBytes = int("MAIN_LOG_CAPACITY_BYTES", 0);
  const maxToolCalls = int("MAX_JOB_TOOL_CALLS", 1);
  const maxTokens = int("MAX_JOB_TOKENS", 1);
  const maxRuntimeSecs = int("MAX_JOB_RUNTIME_SECS", 1);
  const retentionDays = int("MAIN_RETENTION_DAYS", 1) ?? DEFAULT_RETENTION_DAYS;
  const minFreeBytes = int("MAIN_MIN_FREE_BYTES", 0) ?? DEFAULT_MIN_FREE_BYTES;
  if (errors.length) throw new Error(`invalid main node configuration:\n- ${errors.join("\n- ")}`);
  return {
    dataDir: env.DATA_DIR ?? "./data",
    host,
    port,
    publicBaseUrl,
    ...(logCapacityBytes !== undefined ? { logCapacityBytes } : {}),
    budget: {
      ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(maxRuntimeSecs !== undefined ? { maxRuntimeSecs } : {}),
    },
    model,
    ...(scriptFile ? { scriptFile } : {}),
    retentionDays,
    minFreeBytes,
  };
}
