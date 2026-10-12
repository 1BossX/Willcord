#!/usr/bin/env python3
"""Reproduce O1-KR1 diagnosis fixtures and validate probe output + report shape."""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "fixtures" / "diagnosis" / "cases"
LIB = ROOT / "fixtures" / "diagnosis" / "lib"
HEALTH_PORT = 17891

FORBIDDEN_PROBE = re.compile(r"[|;&`<>$]|&&|\|\||\$\(")


def docker_ok() -> bool:
    return shutil.which("docker") is not None and subprocess.run(
        ["docker", "info"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def passwordless_sudo() -> bool:
    return subprocess.run(
        ["sudo", "-n", "true"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def wait_for_tcp(host: str, port: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.25):
                return
        except OSError:
            time.sleep(0.05)
    raise TimeoutError(f"port {host}:{port} not accepting connections within {timeout}s")


def run_probe(command: str) -> tuple[int, str, str]:
    proc = subprocess.run(
        ["/bin/bash", "--noprofile", "--norc", "-c", command],
        capture_output=True,
        text=True,
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": os.environ.get("HOME", "/tmp")},
    )
    return proc.returncode, proc.stdout, proc.stderr


def load_cases() -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for entry in sorted(CASES.iterdir()):
        if not entry.is_dir():
            continue
        case = json.loads((entry / "case.json").read_text(encoding="utf-8"))
        out.append((entry.name, case))
    return out


class HealthServer(threading.Thread):
    def __init__(self, port: int):
        super().__init__(daemon=True)
        self.port = port
        self.proc: subprocess.Popen[bytes] | None = None

    def run(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, str(LIB / "health_server.py"), str(self.port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.proc.wait()

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class DiagnosisFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._health: HealthServer | None = None

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._health:
            cls._health.stop()

    def test_case_records_and_probe_commands(self) -> None:
        for slug, case in load_cases():
            self.assertEqual(case.get("schema_version"), 1)
            self.assertIn("case_id", case)
            for probe in case["probes"]:
                cmd = probe["command"]
                self.assertFalse(
                    FORBIDDEN_PROBE.search(cmd),
                    f"{slug} probe {probe['call_id']} must not use shell operators: {cmd}",
                )

    def test_fixtures_on_linux(self) -> None:
        if sys.platform != "linux":
            self.skipTest("fixture reproduction is defined for Linux")
        for slug, case in load_cases():
            requires = set(case.get("requires") or [])
            if "docker" in requires and not docker_ok():
                continue
            if "sudo" in requires and not passwordless_sudo():
                continue
            self._run_case(slug, case)

    def _run_case(self, slug: str, case: dict) -> None:
        case_dir = CASES / slug
        health = None
        if "loopback_http" in (case.get("requires") or []):
            health = HealthServer(HEALTH_PORT)
            health.start()
            wait_for_tcp("127.0.0.1", HEALTH_PORT)
        try:
            subprocess.run(["bash", str(case_dir / case["setup"])], check=True, cwd=case_dir)
            outputs: dict[str, str] = {}
            for probe in case["probes"]:
                code, out, err = run_probe(probe["command"])
                blob = out + err + f"\nexit={code}"
                outputs[probe["call_id"]] = blob
                for needle in case["expected"].get("probe_outputs_contain", {}).get(probe["call_id"], []):
                    self.assertIn(
                        needle,
                        blob,
                        f"{slug}/{probe['call_id']} missing {needle!r} in output",
                    )
            report = self._build_report(case, outputs)
            self.assertEqual(report["inconclusive"], case["expected"]["inconclusive"])
            self.assertIn("conclusion", report)
            self.assertIn("evidence", report)
            self.assertIn("recommended_next_step", report)
            if case["expected"]["inconclusive"]:
                self.assertEqual(report["conclusion"], "无法确认")
            for pattern in case["expected"].get("conclusion_must_not_match", []):
                self.assertIsNone(
                    re.search(pattern, report["conclusion"]),
                    f"conclusion must not match {pattern}",
                )
        finally:
            subprocess.run(["bash", str(case_dir / case["teardown"])], cwd=case_dir)
            if health:
                health.stop()

    def _build_report(self, case: dict, outputs: dict[str, str]) -> dict:
        calls = []
        for probe in case["probes"]:
            cid = probe["call_id"]
            text = outputs[cid]
            exit_line = text.rsplit("exit=", 1)[-1].strip()
            exit_code = int(exit_line) if exit_line.isdigit() else 1
            stdout = text.rsplit("\nexit=", 1)[0]
            calls.append(
                {
                    "call_id": cid,
                    "tool_name": "bash",
                    "status": "completed",
                    "arguments_json": json.dumps({"command": probe["command"]}),
                    "result_json": json.dumps(
                        {
                            "ok": True,
                            "result": {
                                "exit_code": exit_code,
                                "output": {"stdout": {"text": stdout}},
                            },
                        }
                    ),
                }
            )
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
            json.dump(
                {
                    "summary": case["expected"]["reference_summary"],
                    "calls": calls,
                    "scenario_id": case["scenario_id"],
                },
                tmp,
            )
            tmp_path = tmp.name
        tsx_cli = ROOT / "apps/server/node_modules/tsx/dist/cli.mjs"
        node = subprocess.run(
            ["node", str(tsx_cli), str(ROOT / "fixtures/diagnosis/build-report.ts"), tmp_path],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        os.unlink(tmp_path)
        if node.returncode != 0:
            self.fail(node.stderr or node.stdout)
        return json.loads(node.stdout.strip())


if __name__ == "__main__":
    unittest.main()
