"""Measure the verifier's N15 mutation without a gating timing threshold.
Run alone: production is restored byte-for-byte, even on process failure.
"""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
TARGET = ROOT / "packages/conductor/src/store.ts"
original = TARGET.read_text()
needle = "Key.parse(receipt);\n    const state = this.required(id);"
replacement = "Key.parse(receipt);\n    const state = State.parse(this.required(id));"
if original.count(needle) != 1:
    raise RuntimeError("Full-state-reparse mutation has no unique target")


def measure():
    run = subprocess.run(
        ["node", "packages/conductor/bench/installed-plans.ts", "--short"],
        cwd=ROOT, capture_output=True, text=True, timeout=180,
    )
    if run.returncode:
        raise RuntimeError(run.stdout + run.stderr)
    return [json.loads(line) for line in run.stdout.splitlines() if line.startswith("{")]


baseline = measure()
try:
    TARGET.write_text(original.replace(needle, replacement))
    mutated = measure()
finally:
    TARGET.write_text(original)

result = {
    "mutation": "N15: parse entire state on every apply",
    "notes": "Diagnostic measurements only. No timing pass/fail assertion. Production restored byte-for-byte.",
    "baseline": baseline,
    "mutated": mutated,
}
(ROOT / "packages/conductor/bench/reparse-results.json").write_text(json.dumps(result, indent=2) + "\n")
for before, after in zip(baseline, mutated, strict=True):
    print(f"{before['label']}: baseline {before['usPerOperation']} us, mutated {after['usPerOperation']} us", flush=True)
