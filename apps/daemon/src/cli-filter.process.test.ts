import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { z } from "zod";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";
const identity = z.object({ threadId: ThreadId });

test("a provider-filtered kill stops a Claude parent while its Codex child keeps working", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  try {
    const launched = await invoke(home, [
      "run",
      "Claude parent",
      "--provider",
      "claude",
      "--project",
      f.workspace,
      "--json",
    ]);
    const parent = identity.parse(JSON.parse(launched.stdout)).threadId;
    await f.daemon.engine?.flush();
    const delegated = await invoke(home, [
      "task",
      "spawn",
      "Codex child",
      "--parent",
      parent,
      "--provider",
      "codex",
      "--json",
    ]);
    const child = z.object({ data: identity }).parse(JSON.parse(delegated.stdout)).data.threadId;
    await f.daemon.engine?.flush();
    await f.h.emit(child, {
      type: "turn.started",
      agent: "root",
      trigger: "background_completion",
      nativeTurnId: "working-after-answer",
    });
    await f.daemon.engine?.flush();
    const killed = await invoke(home, [
      "kill-all",
      "--provider",
      "claude",
      "--idempotency-key",
      "claude-only",
      "--json",
    ]);
    expect(killed.code, killed.stderr).toBe(0);
    expect(JSON.parse(killed.stdout)).toMatchObject({
      data: { stopped: [parent], outcome: "cancelled" },
    });
    const status = await invoke(home, ["task", "status", child, "--json"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ state: "working" });
    expect(f.daemon.engine?.queue(child).lastFailure).toBeNull();
    const followup = await invoke(home, ["thread", "send", child, "still runnable", "--json"]);
    expect(followup.code, followup.stderr).toBe(0);
    await f.daemon.engine?.flush();
    expect(f.h.inputs.get(child)).toContain("still runnable");
  } finally {
    await f.daemon.close();
  }
});
