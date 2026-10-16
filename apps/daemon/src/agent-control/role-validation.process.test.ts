import { expect, test } from "vitest";
import { PublicToolError } from "@ace/mcp-server";
import { AgentControlError } from "./failure.ts";
import { daemonFixture } from "./daemon-test-support.ts";

const task = (requestId: string, role: string) => ({
  requestId,
  provider: "claude" as const,
  task: `Do ${requestId}`,
  role,
  wait: false as const,
  estimatedLoad: 0,
});

const batchTask = (requestId: string, role: string) => ({
  requestId,
  provider: "claude" as const,
  task: `Do ${requestId}`,
  role,
  estimatedLoad: 0,
});

/** The refusal an agent reads: what to rename and what a good name looks like. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  const failure = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (failure instanceof AgentControlError && failure.publicDetail) return failure.publicDetail;
  if (failure instanceof PublicToolError && failure.detail) return failure.detail;
  throw new Error(`Expected a role refusal, got ${String(failure)}`);
}

test("delegate_task refuses generic and repeated roles with a descriptive retry", async () => {
  const f = await daemonFixture();
  try {
    expect(
      await refusal(f.call({ op: "delegate_task", ...task("first", "Implementer") })),
    ).toContain("Fix-869-worked-for-toast");
    const child = await f.call({ op: "delegate_task", ...task("second", "fix-869-toast") });
    expect(child.ok).toBe(true);
    // Same display name, different task: refused while the first child lives.
    expect(
      await refusal(f.call({ op: "delegate_task", ...task("third", "Fix-869-Toast") })),
    ).toContain("already used");
    // A numbered retry of a generic name is still generic.
    expect(await refusal(f.call({ op: "delegate_task", ...task("fourth", "Worker 2") }))).toContain(
      "generic",
    );
    // Retrying the same requestId with its own name resolves to the same child.
    const again = await f.call({ op: "delegate_task", ...task("second", "fix-869-toast") });
    expect(again).toMatchObject({ ok: true, data: child.data });
    // Two new tasks sharing one name never half-start.
    expect(
      await refusal(
        f.call({
          op: "delegate_task",
          tasks: [batchTask("batch-a", "batch-review"), batchTask("batch-b", "Batch-Review")],
        }),
      ),
    ).toContain("twice");
    expect(f.controls.delegations.journal.children(f.caller.threadId)).toHaveLength(1);
  } finally {
    await f.daemon.close();
  }
});
