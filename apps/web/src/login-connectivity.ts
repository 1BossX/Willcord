import { blockerMessage, installBlockers } from "./install-blockers.ts";

function isUnauthorized(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    (cause as { status: number }).status === 401
  );
}

/** Map a failed login or session probe to an outsider-facing blocker when TLS is the issue. */
export function loginFailureMessage(cause: unknown): string {
  if (isUnauthorized(cause)) return "密码不正确，请重试。";
  if (isTlsOrNetworkFailure(cause)) return blockerMessage(installBlockers.caUntrusted);
  if (cause instanceof Error) return cause.message;
  return "登录失败，请稍后重试。";
}

export function isTlsOrNetworkFailure(cause: unknown): boolean {
  if (cause instanceof TypeError) return true;
  if (!(cause instanceof Error)) return false;
  const message = cause.message.toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("load failed") ||
    message.includes("ssl") ||
    message.includes("certificate") ||
    message.includes("net::err_cert")
  );
}
