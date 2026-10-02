"""Non-gating behavioural mutation audit. Each temporary edit is restored in finally."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
mutations = [
    ("fanout prompt", "state.ts", "prompt: lane.prompt,", 'prompt: "wrong task",', "orchestration.test.ts"),
    ("race first passing winner", "lifecycle.ts", 'm.state.input.template.kind === "race"', 'm.state.input.template.kind === "race" && false', "orchestration.test.ts"),
    ("cancellation acknowledgement", "lifecycle.ts", 'phase(m, lane, "cancelling");', 'finish(m, lane, "cancelled");', "budgets.test.ts"),
    ("pipeline artifact transfer", "lifecycle.ts", 'start(m, next, lane.artifact);', 'start(m, next);', "orchestration.test.ts"),
    ("coordinator depth", "reduce.ts", 'parent.depth >= state.input.template.budget.maxDepth', 'parent.depth > state.input.template.budget.maxDepth', "coordinator.test.ts"),
    ("token budget boundary", "reduce.ts", 's.usage.tokens >= b.tokens', 's.usage.tokens > b.tokens', "budgets.test.ts"),
    ("stale attempt isolation", "reduce.ts", '!lane || lane.attempt !== fact.attempt', '!lane', "budgets.test.ts"),
    ("cumulative usage deduplication", "reduce.ts", 'Math.max(lane.attemptUsage.tokens, fact.usage.tokens)', 'lane.attemptUsage.tokens + fact.usage.tokens', "budgets.test.ts"),
    ("waiting descendants", "lifecycle.ts", 'if (lane.children > 0) {\n    phase(m, lane, "joining");', 'if (false) {\n    phase(m, lane, "joining");', "coordinator.test.ts"),
    ("optional review gate", "reduce.ts", 'fact.commandPassed && (!state.input.template.checks.review || fact.reviewPassed === true)', 'fact.commandPassed', "orchestration.test.ts"),
    ("recovery intent replay", "recovery.ts", 'intents: Object.values(state.intents)', 'intents: []', "orchestration.test.ts"),
    ("target branch guard", "git.ts", 'info.branch !== state.input.targetBranch || info.head !== state.input.baseRef', 'info.head !== state.input.baseRef', "git.test.ts"),
]
for name, file, original, replacement, test in mutations:
    path = ROOT / "packages/orchestrator/src" / file
    source = path.read_text()
    if source.count(original) != 1:
        raise RuntimeError(f"Mutation {name} needs exactly one matching edit")
    try:
        path.write_text(source.replace(original, replacement))
        result = subprocess.run(["bun", "run", "test", f"packages/orchestrator/src/{test}"], cwd=ROOT, capture_output=True, text=True)
        if result.returncode == 0:
            raise RuntimeError(f"Mutation survived: {name}")
        output = result.stdout + result.stderr
        failures = [line.strip() for line in output.splitlines() if " FAIL " in line]
        if not failures:
            raise RuntimeError(f"No behavioural assertion failed for {name}: {output[-2000:]}")
        print(f"KILLED: {name}: {failures[0]}", flush=True)
    finally:
        path.write_text(source)
