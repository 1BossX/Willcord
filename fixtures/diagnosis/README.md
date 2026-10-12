# O1-KR1 diagnosis fixtures (票3)

Reproducible host faults for the three diagnosis scenarios plus one **无法确认** case. Case records use a stable JSON shape so later **O1-KR3** (20 predefined cases) can add rows without redefining the format.

## Layout

- `schema.json` — case record schema (version 1).
- `lib/case-lib.sh` — shared setup paths and helpers (not used as diagnosis probes).
- `cases/<slug>/case.json` — metadata, allowlisted **probe** commands, expected report shape.
- `cases/<slug>/setup.sh` / `teardown.sh` — create and remove the fault on Linux.

## Probe commands

Probes are the read-only inspection commands a diagnosis run may execute. They must:

- Match the worker diagnosis allowlist (票1 / `worker/src/diagnosis.rs`).
- Be a **single** command string with **no** shell operators: no `|`, `;`, `&&`, `||`, redirects, command substitution, or `bash -c`.
- Avoid globs and unexpanded variables in the command text (the worker will move to argv `exec`; fixtures must stay valid then).

Setup/teardown scripts may use bash for orchestration; they are not executed inside diagnosis mode.

## Run locally

```bash
# After: cargo build --manifest-path worker/Cargo.toml
python3 deploy/test-diagnosis-fixtures.py
pnpm --filter @willcord/server test
```

Docker is required for the docker-service and inconclusive cases; disk and post-deploy cases need `sudo` for loop mount (disk) or a free local TCP port (post-deploy).

## Cases

| Slug | Scenario | Fault |
|------|----------|--------|
| `docker-service-exited` | docker-service | Container exits with code 1 |
| `disk-usage-near-full` | disk-usage | Loop-mounted ext4 at ~100% |
| `post-deploy-health-fail` | post-deploy | Local HTTP health returns 503 |
| `inconclusive-healthy-container` | docker-service | Running container, no failed service to explain |
