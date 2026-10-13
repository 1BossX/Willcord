#!/usr/bin/env python3
"""O2-KR3 acceptance doc must list four fault types and point at automated evidence."""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs" / "dev" / "acceptance" / "o2-kr3-four-fault-types.md"
SMOKE = ROOT / "deploy" / "docker" / "smoke.sh"

REQUIRED_TESTS = (
    "p3-faults.test.ts",
    "p3-main-process.test.ts",
    "p4-faults.test.ts",
    "p4-control.test.ts",
    "p6-faults.test.ts",
    "lock.test.ts",
)


class O2Kr3AcceptanceDoc(unittest.TestCase):
    def test_doc_exists_and_covers_four_types(self) -> None:
        text = DOC.read_text(encoding="utf-8")
        self.assertIn("O2-KR3", text)
        self.assertIn("厚轨", text)
        for heading in (
            "断线",
            "主节点重启",
            "取消",
            "结果丢失",
        ):
            self.assertIn(heading, text, msg=f"missing fault type section: {heading}")
        self.assertIn("restart: \"no\"", text)
        self.assertIn("main.lock", text)
        self.assertIn("不盲目重跑", text)
        self.assertIn("needs_attention", text)

    def test_doc_references_fault_program_tests(self) -> None:
        text = DOC.read_text(encoding="utf-8")
        for name in REQUIRED_TESTS:
            self.assertIn(name, text, msg=f"doc must cite {name}")

    def test_docker_smoke_covers_crash_lock(self) -> None:
        smoke = SMOKE.read_text(encoding="utf-8")
        self.assertIn("SIGKILL", smoke)
        self.assertIn("main.lock", smoke)
        self.assertRegex(smoke, re.compile(r"restart.*no|RestartPolicy", re.I))


if __name__ == "__main__":
    unittest.main(verbosity=2)
