import { afterEach, expect, test } from "vitest";
import { fixture, cleanupRecovery } from "./recovery-test-support.ts";
import { scriptFrames, start } from "./test-support.ts";

afterEach(cleanupRecovery);

test.each(["signal", "timer"])(
  "a child silence deadline follows a backward clock across provider batches via %s",
  async (trigger) => {
    const frames = scriptFrames();
    const h = await fixture(
      [
        {
          on: "send",
          frames: [
            frames.frame(
              start,
              {
                type: "agent.seen",
                agent: "child",
                parent: "root",
                origin: "provider_subagent",
                fidelity: "full",
                cwd: "/repo",
                native: { provider: "codex" },
              },
              { type: "turn.started", agent: "child", trigger: "spawn" },
            ),
          ],
        },
      ],
      frames,
    );
    const id = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing provider");
    for (const at of [1050, 1020]) {
      h.clock.time = at;
      context.onFrame(frames.frame({ type: "signal", agent: "child" }));
      await h.engine.flush();
    }
    if (trigger === "timer") {
      h.clock.advance(1121);
      await h.engine.flush();
      expect(
        Object.values(h.store.snapshotThread(id).agents).find((agent) => agent.parentId !== null)
          ?.status,
      ).toEqual({ state: "unresponsive", lastSignalAt: 1020 });
    }
    h.clock.time = 1130;
    context.onFrame(frames.frame({ type: "signal", agent: "root" }));
    await h.engine.flush();
    const child = () =>
      Object.values(h.store.snapshotThread(id).agents).find((agent) => agent.parentId !== null);
    expect(child()?.status).toEqual({ state: "unresponsive", lastSignalAt: 1020 });
    expect(h.store.getThread(id)?.status).toEqual({ state: "working", agents: 1 });
    context.onFrame(frames.frame({ type: "signal", agent: "child" }));
    await h.engine.flush();
    expect(child()?.status.state).toBe("working");
    expect(h.store.getThread(id)?.status).toEqual({ state: "working", agents: 2 });
  },
);
