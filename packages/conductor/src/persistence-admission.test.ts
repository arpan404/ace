import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { ConductorStore, progress } from "./index.ts";
import { fixture } from "./review-test-support.ts";
import { plan, spec } from "./test-support.ts";

it("running control uses its admitted immutable plan and rejects corrupted artifacts on restore", async () => {
  const context = fixture();
  try {
    const project = plan({ a: [], b: [], c: [], d: [], e: [], f: [] });
    for (const stream of project.workstreams)
      stream.brief.files = Array.from({ length: 128 }, (_, i) => `src/${stream.id}/file-${i}.ts`);
    await context.install(project);
    const worker = progress(context.state()).lanes[0];
    if (!worker) throw new Error("Worker missing");
    // A competing/corrupted disk snapshot must not cause the live actor to
    // re-admit or replace an immutable artifact on every heartbeat.
    const db = new DatabaseSync(context.path);
    try {
      db.prepare(
        "UPDATE conductor_runs SET payload=json_set(payload,'$.plan',json(?)) WHERE id=?",
      ).run(JSON.stringify({ summary: "Corrupt", workstreams: [] }), "run");
    } finally {
      db.close();
    }
    context.send({
      type: "status",
      laneId: worker.id,
      generation: 0,
      status: "waiting",
      at: context.env.now(),
    });
    expect(progress(context.state()).plan?.summary).toBe(project.summary);
    expect(progress(context.state()).lanes.find((l) => l.id === worker.id)?.status).toBe("waiting");
    const reopened = new ConductorStore(context.path);
    try {
      expect(() => reopened.load("run")).toThrow();
    } finally {
      reopened.close();
    }
  } finally {
    context.close();
  }
});

it("loaded artifacts cannot be mutated through caller references", async () => {
  const context = fixture();
  try {
    await context.install();
    const stream = context.state().plan?.workstreams[0];
    if (!stream) throw new Error("Plan missing");
    expect(() => stream.brief.acceptance.push("caller changed requirement")).toThrow();
    const reopened = new ConductorStore(context.path);
    try {
      const state = reopened.load("run");
      if (!state) throw new Error("Run missing");
      expect(progress(state).plan?.workstreams[0]?.brief.acceptance).toEqual(["a works"]);
    } finally {
      reopened.close();
    }
  } finally {
    context.close();
  }
});

it("legacy snapshots migrate once while preserving lane order and input receipts", async () => {
  const context = fixture();
  try {
    await context.install(plan({ z: [], a: [], b: [] }));
    const legacy = context.state();
    const db = new DatabaseSync(context.path);
    try {
      db.prepare("UPDATE conductor_runs SET payload=? WHERE id=?").run(
        JSON.stringify(legacy),
        "run",
      );
    } finally {
      db.close();
    }
    const upgraded = new ConductorStore(context.path);
    try {
      const state = upgraded.load("run");
      if (!state) throw new Error("Run missing");
      expect(progress(state).lanes.map((l) => l.workstream)).toEqual(["z", "a", "b"]);
      // The original account receipt remains first-answer-wins after upgrade.
      upgraded.apply("run", "accounts", { type: "cancel" }, context.env);
      expect(progress(upgraded.load("run") ?? state).phase).toBe("running");
    } finally {
      upgraded.close();
    }
    const restored = new ConductorStore(context.path);
    try {
      const state = restored.load("run");
      if (!state) throw new Error("Run missing");
      expect(progress(state).lanes.map((l) => l.workstream)).toEqual(["z", "a", "b"]);
    } finally {
      restored.close();
    }
  } finally {
    context.close();
  }
});

it("active actor capacity applies backpressure and terminal release admits another run", async () => {
  const context = fixture();
  try {
    for (let i = 1; i < 8; i++) context.store.create(`run-${i}`, spec(), context.env);
    expect(() => context.store.create("overflow", spec(), context.env)).toThrow(
      "actor_backpressure",
    );
    expect(() => context.store.release("run")).toThrow("run_still_live");
    context.driver.command("cancel", { type: "conductor.cancel", runId: "run" });
    await context.driver.drain("run");
    context.store.release("run");
    context.store.create("overflow", spec(), context.env);
    expect(progress(context.store.load("overflow") ?? context.state()).phase).toBe("planning");
  } finally {
    context.close();
  }
});

it("cold restore rejects tampered content-addressed artifacts", async () => {
  const context = fixture();
  try {
    await context.install();
    const db = new DatabaseSync(context.path);
    try {
      db.prepare("UPDATE conductor_artifacts SET payload=replace(payload,?,?) WHERE run=?").run(
        "A bounded project",
        "A corrupt project",
        "run",
      );
    } finally {
      db.close();
    }
    const reopened = new ConductorStore(context.path);
    try {
      expect(() => reopened.load("run")).toThrow("artifact_digest_mismatch");
    } finally {
      reopened.close();
    }
  } finally {
    context.close();
  }
});
