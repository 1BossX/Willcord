// Test-only crash points for the P3/P4 fault programs. WP_MAIN_FAULT names one
// commit point; the process SIGKILLs itself there so no shutdown code runs.
// Honoured only with a scripted model, so a real deployment never crashes here.
export type MainFaultPoint = "before_dispatch" | "after_dispatch" | "after_result_commit" | "after_cancel_commit";

export function mainFault(point: MainFaultPoint) {
  const scripted = process.env.P2_FAKE_MODEL === "1" || Boolean(process.env.P3_FAKE_SCRIPT_FILE);
  if (!scripted || process.env.WP_MAIN_FAULT !== point) return;
  console.error(`fault injection: SIGKILL at ${point}`);
  process.kill(process.pid, "SIGKILL");
}
