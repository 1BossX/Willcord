# Security policy

Willcord is pre-1.0 (latest release: v0.1.0-beta.1). Support is best-effort with no response-time guarantee, and only the latest release receives fixes.

中文摘要：项目处于 1.0 之前的开发与受控验收阶段，仅对最新版本尽力修复。核心前提：Bash 不是沙箱、仅限单管理员、文件与命令输出可能进入模型上下文；CA 指纹只能从可信控制台复制。

## Deployment boundary

- This is a single-administrator control plane, not a multi-tenant execution service. Do not grant untrusted users access to an administrator session.
- Bash runs with the worker service account's actual permissions. A workspace fixes the working directory; it is **not a shell sandbox**. Use a dedicated, least-privileged account without access to unrelated projects or credentials.
- Model keys stay on the main node. Workers still hold device private keys and credentials, stored in the worker's private install directory (mode 0700/0600). Protect worker data, the main database and backups as sensitive data.
- Model inputs may include file contents, command output and conversation history. Review your model provider's data handling before sending sensitive workloads.
- Reconciliation avoids blind replay of uncertain executions. It does not guarantee exactly-once external side effects for arbitrary commands. Resolve unknown states before continuing.
- Use validated HTTPS/WSS and never disable TLS verification. Copy the install command (its join link carries the CA fingerprint after `#sha256=`) only from a trusted console or administrator channel; do not take a fingerprint from the same unverified connection you are about to trust.
- The main node CA fingerprint is not the worker public-key fingerprint that you compare when approving a device. Verify both separately.
- Follow `docs/installation.md`, `docs/operations.md` and `docs/worker-onboarding.md`.

## Reporting vulnerabilities

Use GitHub's **Report a vulnerability** option under this repository's Security tab when private vulnerability reporting is enabled. Do not post credentials, exploit details against live machines, or private execution output in a public issue.

If private reporting is unavailable, open an issue containing only a request for a private reporting channel; wait for a maintainer to provide one before sharing sensitive details.

## CI isolation

Repository workflows use GitHub-hosted runners. Do not attach trusted internal self-hosted runners to untrusted pull-request jobs. Release builds and website publication are separate from production deployment.
