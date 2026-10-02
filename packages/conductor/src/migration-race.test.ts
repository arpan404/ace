import { expect, it } from "vitest";
import { ConductorStore, ConductorDriver, executor, progress } from "./index.ts";
import { fixture } from "./review-test-support.ts";
import { completion } from "./test-support.ts";

it.each(["artifact-first", "status-first"])(
  "replacement completion during awaited migration is preserved, %s",
  async (order) => {
    const context = fixture();
    try {
      await context.install();
      const worker = progress(context.state()).lanes[0];
      if (!worker) throw new Error("Worker missing");
      const original = context.fake.ports.accounts.migrate;
      context.fake.ports.accounts.migrate = async (key, lane, from) => {
        await original(key, lane, from);
        const artifact = {
          type: "artifact",
          laneId: lane.id,
          generation: lane.generation,
          artifact: { kind: "completion", completion: completion() },
        };
        const status = {
          type: "status",
          laneId: lane.id,
          generation: lane.generation,
          status: "done",
          at: context.env.now(),
        };
        for (const fact of order === "artifact-first" ? [artifact, status] : [status, artifact])
          context.send(fact);
      };
      const session = context.fake.sessions.get(worker.id);
      if (!session) throw new Error("Session missing");
      session.history.push("user: implement a", "tool: observed output", "assistant: completed a");
      const history = [...session.history];
      context.send({ type: "usage_limit", laneId: worker.id, generation: worker.generation });
      await context.driver.drain("run");
      expect(progress(context.state()).dag[0]?.state).toBe("reviewing");
      expect(progress(context.state()).lanes[0]?.role).toBe("reviewer");
      expect(context.fake.sessions.get(worker.id)?.history).toEqual(history);
      expect(context.fake.sessions.get(worker.id)?.lane.account).toBe("two");
      expect(context.store.pending("run")).toEqual([]);
    } finally {
      context.close();
    }
  },
);

it("migration completion observations survive a restart before acknowledgement", async () => {
  const context = fixture();
  let reopened: ConductorStore | undefined;
  try {
    await context.install();
    const worker = progress(context.state()).lanes[0];
    if (!worker) throw new Error("Worker missing");
    context.send({ type: "usage_limit", laneId: worker.id, generation: worker.generation });
    const effect = context.store.pending("run").find((e) => e.type === "migrate");
    if (!effect || effect.type !== "migrate") throw new Error("Migration missing");
    // External migration succeeds, emits facts, then the daemon dies before its ack.
    await executor(context.fake.ports)(effect);
    context.send({
      type: "artifact",
      laneId: worker.id,
      generation: effect.lane.generation,
      artifact: { kind: "completion", completion: completion() },
    });
    context.send({
      type: "status",
      laneId: worker.id,
      generation: effect.lane.generation,
      status: "done",
      at: context.env.now(),
    });
    reopened = new ConductorStore(context.path);
    const driver = new ConductorDriver(reopened, executor(context.fake.ports), context.env);
    await driver.drain("run");
    const state = reopened.load("run");
    if (!state) throw new Error("Run missing");
    expect(progress(state).dag[0]?.state).toBe("reviewing");
    expect(
      [...context.fake.sessions.values()].filter((s) => s.lane.role === "reviewer"),
    ).toHaveLength(1);
  } finally {
    reopened?.close();
    context.close();
  }
});
