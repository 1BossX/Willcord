#!/usr/bin/env python3
"""Fail when checkout follows a workspace download-artifact.

actions/checkout deletes the working directory when it is not already a git
checkout. Digests downloaded into that directory are gone, so the multi-arch
image tag step cannot read them. A download under runner.temp is outside the
workspace and survives. Checkout before the download is also safe.
"""
import sys
from pathlib import Path


def _jobs(text):
    lines = text.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.startswith("jobs:"))
    except StopIteration:
        return []
    jobs = []
    name = None
    body = []
    for line in lines[start + 1 :]:
        if line.startswith("  ") and not line.startswith("   ") and line.rstrip().endswith(":"):
            if name is not None:
                jobs.append((name, body))
            name = line.strip()[:-1]
            body = []
            continue
        if line and not line.startswith(" ") and not line.startswith("#"):
            break
        if name is not None:
            body.append(line)
    if name is not None:
        jobs.append((name, body))
    return jobs


def _steps(body):
    steps = []
    current = None
    base = None
    for line in body:
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)
        if stripped.startswith("- ") and (base is None or indent == base):
            if current is not None:
                steps.append(current)
            base = indent
            current = {"uses": "", "path": None, "saw_path": False}
            rest = stripped[2:]
            if rest.startswith("uses:"):
                current["uses"] = rest.split(":", 1)[1].strip().strip("'\"")
            continue
        if current is None or base is None or indent <= base:
            continue
        if stripped.startswith("uses:") and not current["uses"]:
            current["uses"] = stripped.split(":", 1)[1].strip().strip("'\"")
        elif stripped.startswith("path:"):
            current["saw_path"] = True
            current["path"] = stripped.split(":", 1)[1].strip().strip("'\"")
    if current is not None:
        steps.append(current)
    return steps


def _workspace_download(step):
    uses = step["uses"]
    if "actions/download-artifact@" not in uses and not uses.startswith("actions/download-artifact"):
        return False
    path = step["path"] or ""
    if not step["saw_path"]:
        return True
    return "runner.temp" not in path and "RUNNER_TEMP" not in path


def problems_in(text, filename="<workflow>"):
    found = []
    for name, body in _jobs(text):
        steps = _steps(body)
        unsafe = False
        for step in steps:
            if "actions/checkout@" in step["uses"]:
                if unsafe:
                    found.append(f"{filename}: job {name}: checkout follows a workspace download-artifact")
                    unsafe = False
            elif _workspace_download(step):
                unsafe = True
    return found


def _self_check():
    bad = """
jobs:
  publish:
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: digests
      - uses: actions/checkout@v4
"""
    safe_temp = """
jobs:
  publish:
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: ${{ runner.temp }}/digests
      - uses: actions/checkout@v4
"""
    safe_order = """
jobs:
  publish:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          path: release
"""
    missing_path = """
jobs:
  publish:
    steps:
      - uses: actions/download-artifact@v4
      - uses: actions/checkout@v4
"""
    if not problems_in(bad):
        raise SystemExit("checker missed checkout after a workspace download")
    if problems_in(safe_temp):
        raise SystemExit("checker flagged a runner.temp download")
    if problems_in(safe_order):
        raise SystemExit("checker flagged checkout before download")
    if not problems_in(missing_path):
        raise SystemExit("checker missed a download with no path")


def main(argv):
    _self_check()
    failed = []
    for name in argv[1:]:
        text = Path(name).read_text(encoding="utf-8")
        failed.extend(problems_in(text, name))
    if failed:
        print("\n".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
