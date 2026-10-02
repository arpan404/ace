import { expect, it } from "vitest";
import { ConductorDriver, ConductorStore, executor, nextDeadline, progress } from "./index.ts";
import { fixture } from "./review-test-support.ts";
import { completion } from "./test-support.ts";

it.each(["before acknowledgement", "after acknowledgement"])(
  "repeated buffered done cannot postpone the artifact gate %s",
  async (when) => {
    const context = fixture();
    const started = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    let draining: Promise<number> | undefined;
    try {
      await context.install();
      const worker = progress(context.state()).lanes[0];
      if (!worker) throw new Error("Worker missing");
      const original = context.fake.ports.accounts.migrate;
      context.fake.ports.accounts.migrate = async (key, lane, from) => {
        await original(key, lane, from);
        started.resolve();
        await acknowledge.promise;
      };
      context.send({ type: "usage_limit", laneId: worker.id, generation: worker.generation });
      draining = context.driver.drain("run");
      await started.promise;
      const done = () =>
        context.send({
          type: "status",
          laneId: worker.id,
          generation: worker.generation + 1,
          status: "done",
          at: context.env.now(),
        });
      done();
      context.env.advance(900);
      done();
      if (when === "after acknowledgement") {
        acknowledge.resolve();
        await draining;
      }
      expect(nextDeadline(context.state())).toBe(1100);
      context.env.advance(100);
      context.send({ type: "tick" });
      expect(progress(context.state()).needsUser).toEqual([
        expect.objectContaining({
          kind: "escalation",
          lane: worker.id,
          message: expect.stringContaining("artifact"),
        }),
      ]);
      expect(nextDeadline(context.state())).toBeNull();
      for (let i = 0; i < 100; i++) {
        context.env.advance(900);
        done();
        context.send({ type: "tick" });
      }
      expect(progress(context.state()).needsUser).toHaveLength(1);
      expect(progress(context.state()).phase).not.toBe("done");
    } finally {
      acknowledge.resolve();
      await draining;
      context.close();
    }
  },
);

it("a buffered artifact deadline survives SQLite restore and late acknowledgement cannot bypass its gate", async () => {
  const context = fixture();
  let reopened: ConductorStore | undefined;
  try {
    await context.install();
    const worker = progress(context.state()).lanes[0];
    if (!worker) throw new Error("Worker missing");
    context.send({ type: "usage_limit", laneId: worker.id, generation: worker.generation });
    const migration = context.store.pending("run").find((effect) => effect.type === "migrate");
    if (!migration || migration.type !== "migrate") throw new Error("Migration missing");
    await executor(context.fake.ports)(migration);
    const done = () =>
      context.send({
        type: "status",
        laneId: worker.id,
        generation: migration.lane.generation,
        status: "done",
        at: context.env.now(),
      });
    done();
    context.env.advance(900);
    done();
    reopened = new ConductorStore(context.path);
    const driver = new ConductorDriver(reopened, executor(context.fake.ports), context.env);
    const state = () => {
      const value = reopened?.load("run");
      if (!value) throw new Error("Run missing");
      return value;
    };
    expect(nextDeadline(state())).toBe(1100);
    context.env.advance(100);
    driver.fact("run", "expire", { type: "tick" });
    reopened.complete(
      "run",
      migration.id,
      [{ type: "migrated", laneId: worker.id, generation: migration.lane.generation }],
      context.env,
    );
    driver.fact("run", "late-artifact", {
      type: "artifact",
      laneId: worker.id,
      generation: migration.lane.generation,
      artifact: { kind: "completion", completion: completion() },
    });
    await driver.drain("run");
    expect(progress(state()).needsUser[0]?.message).toContain("artifact");
    expect(
      [...context.fake.sessions.values()].filter((session) => session.lane.role === "reviewer"),
    ).toEqual([]);
    expect(context.fake.interactions.size).toBe(1);
  } finally {
    reopened?.close();
    context.close();
  }
});

it("a buffered done with an artifact cannot postpone a stalled migration acknowledgement", async () => {
  const context = fixture();
  try {
    await context.install();
    const worker = progress(context.state()).lanes[0];
    if (!worker) throw new Error("Worker missing");
    context.send({ type: "usage_limit", laneId: worker.id, generation: worker.generation });
    const generation = worker.generation + 1;
    context.send({
      type: "artifact",
      laneId: worker.id,
      generation,
      artifact: { kind: "completion", completion: completion() },
    });
    const done = () =>
      context.send({
        type: "status",
        laneId: worker.id,
        generation,
        status: "done",
        at: context.env.now(),
      });
    done();
    context.env.advance(900);
    done();
    expect(nextDeadline(context.state())).toBe(1100);
    context.env.advance(100);
    context.send({ type: "tick" });
    expect(progress(context.state()).needsUser[0]?.message).toContain("stalled");
    context.send({ type: "migrated", laneId: worker.id, generation });
    expect(progress(context.state()).lanes[0]?.status).toBe("done");
    expect(progress(context.state()).dag[0]?.state).toBe("escalated");
  } finally {
    context.close();
  }
});

it.each(["before", "after"])(
  "older work cannot replace newer buffered completion %s acknowledgement",
  async (when) => {
    const context = fixture();
    try {
      await context.install();
      const worker = progress(context.state()).lanes[0];
      if (!worker) throw new Error("Worker missing");
      const generation = worker.generation + 1;
      context.send({ type: "usage_limit", laneId: worker.id, generation: worker.generation });
      const done = () =>
        context.send({
          type: "status",
          laneId: worker.id,
          generation,
          status: "done",
          at: context.env.now(),
        });
      done();
      context.env.advance(900);
      done();
      if (when === "after") context.send({ type: "migrated", laneId: worker.id, generation });
      context.send({ type: "status", laneId: worker.id, generation, status: "working", at: 900 });
      expect(nextDeadline(context.state())).toBe(1100);
      expect(progress(context.state()).lanes[0]?.status).toBe(
        when === "after" ? "done" : "migrating",
      );
      context.env.advance(100);
      context.send({ type: "tick" });
      expect(progress(context.state()).needsUser[0]?.message).toContain("artifact");
    } finally {
      context.close();
    }
  },
);
