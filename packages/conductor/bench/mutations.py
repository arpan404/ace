"""Run deliberate production mutations, require behavioural test failures, restore each file."""
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
mutations = [
    ("completion without tree done", "packages/conductor/src/completion.ts", 'lane.status !== "done" || ', '', "reducer"),
    ("dependencies satisfied before verification", "packages/conductor/src/scheduler.ts", 'state.nodes[d]?.state === "integrated"', 'state.nodes[d]?.state !== "pending"', "reducer"),
    ("parallel cap permits another lane", "packages/conductor/src/scheduler.ts", 'active >= spec.constraints.maxParallel', 'active > spec.constraints.maxParallel', "artifacts"),
    ("quota reservations ignored", "packages/conductor/src/scheduler.ts", 'account.quota - used.quota < model.quota', 'account.quota - used.quota < 0', "artifacts"),
    ("reviewer prefers worker model", "packages/conductor/src/scheduler.ts", 'score(b) - score(a)', 'score(a) - score(b)', "artifacts"),
    ("fix round cap permits an extra round", "packages/conductor/src/completion.ts", 'node.fixRounds < ctx.state.spec.policies.maxFixRounds', 'node.fixRounds <= ctx.state.spec.policies.maxFixRounds', "reducer"),
    ("budget reservation always allowed", "packages/conductor/src/transition.ts", 'if (ctx.state.spent + cost <= ctx.state.spec.constraints.budget) return true;', 'if (cost >= 0) return true;', "resilience"),
    ("migration does not advance generation", "packages/conductor/src/advance.ts", 'lane.generation++;', 'lane.generation += 0;', "resilience"),
    ("failed verification marks integrated", "packages/conductor/src/reducer.ts", 'if (fact.passed) {', 'if (fact.summary.length > 0) {', "reducer"),
    ("wrong review revision accepted", "packages/conductor/src/completion.ts", 'if (!node || artifact.revision !== node.completion?.revision)', 'if (!node || artifact.revision.length === 0)', "reducer"),
    ("pause allows dispatch", "packages/conductor/src/advance.ts", 'if (s.phase === "paused" || s.phase === "cancelled" || s.phase === "done") return;', 'if (s.phase === "cancelled" || s.phase === "done") return;', "resilience"),
    ("review protocol accepts fourteen mutations", "packages/protocol/src/conductor.ts", '.min(15)', '.min(14)', "artifacts"),
]
mutations.extend([
    ("root done ignores live trees", "packages/conductor/src/advance.ts", '    Object.values(s.lanes).every((l) => !l.live) &&\n', '', "review-quality"),
    ("reviewer omits repository rules", "packages/conductor/src/prompts.ts", '    quoted("Repository rules", rules),\n', '', "artifacts"),
])
results = []
with tempfile.TemporaryDirectory(prefix="ace-conductor-mutations-") as directory:
    for i, (name, file, original, replacement, suite) in enumerate(mutations):
        target = ROOT / file
        contents = target.read_text()
        if contents.count(original) != 1:
            raise RuntimeError(f"Mutation {name} has no unique target")
        report = Path(directory) / f"{i}.json"
        try:
            target.write_text(contents.replace(original, replacement))
            command = ["bun", "run", "test", f"packages/conductor/src/{suite}.test.ts", "--reporter=json", f"--outputFile={report}"]
            run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
            data = json.loads(report.read_text()) if report.exists() else {}
            failures = [a["fullName"] for t in data.get("testResults", []) for a in t.get("assertionResults", []) if a["status"] == "failed"]
            if run.returncode == 0 or not failures:
                raise RuntimeError(f"Mutation survived or failed without an assertion: {name}\n{run.stdout}\n{run.stderr}")
            results.append({"mutation": name, "file": file, "failingTest": failures[0]})
            print(f"Killed: {name}: {failures[0]}", flush=True)
        finally:
            target.write_text(contents)
(ROOT / "packages/conductor/bench/mutation-results.json").write_text(json.dumps(results, indent=2) + "\n")
