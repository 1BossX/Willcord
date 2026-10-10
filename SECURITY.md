# Security policy

Willcord / WorkerPlane is under development. There is no production support or response-time guarantee yet.

## Deployment boundary

- This is a single-administrator control plane, not a multi-tenant execution service. Do not grant untrusted users access to an administrator session.
- Bash runs with the worker service account's actual permissions. A workspace fixes the working directory; it is **not a shell sandbox**. Use a dedicated, least-privileged account without access to unrelated projects or credentials.
- Model keys stay on the main node. Workers still hold device private keys and credentials. Protect worker data, the main database and backups as sensitive data.
- Model inputs may include file contents, command output and conversation history. Review your model provider's data handling before sending sensitive workloads.
- Reconciliation avoids blind replay of uncertain executions. It does not guarantee exactly-once external side effects for arbitrary commands. Resolve unknown states before continuing.
- Use validated HTTPS/WSS and follow `docs/operations.md` and `docs/worker-onboarding.md`.

## Reporting vulnerabilities

Use GitHub's **Report a vulnerability** option under this repository's Security tab when private vulnerability reporting is enabled. Do not post credentials, exploit details against live machines, or private execution output in a public issue.

If private reporting is unavailable, open an issue containing only a request for a private reporting channel; wait for a maintainer to provide one before sharing sensitive details.

## CI isolation

Repository workflows use GitHub-hosted runners. Do not attach trusted internal self-hosted runners to untrusted pull-request jobs. Release builds and website publication are separate from production deployment.
