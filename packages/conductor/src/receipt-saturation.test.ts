import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { progress } from "./index.ts";
import { fixture } from "./review-test-support.ts";

function fillReceipts(path: string, count: number) {
  const db = new DatabaseSync(path);
  try {
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO conductor_inputs(run,id) VALUES (?,?)");
    for (let i = 0; i < count; i++) insert.run("run", `received-${i}`);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

it.each([65_536, 66_560])(
  "%s receipts keep cancellation and terminal lane cleanup available",
  async (count) => {
    const context = fixture();
    try {
      await context.driver.drain("run");
      const planner = progress(context.state()).lanes[0];
      if (!planner) throw new Error("Planner missing");
      fillReceipts(context.path, count);
      expect(() =>
        context.send({
          type: "status",
          laneId: planner.id,
          generation: 0,
          status: "working",
          at: context.env.now(),
        }),
      ).toThrow("input_backpressure");
      context.driver.command("cancel", { type: "conductor.cancel", runId: "run" });
      context.driver.command("cancel-retry", { type: "conductor.cancel", runId: "run" });
      context.send({
        type: "status",
        laneId: planner.id,
        generation: 0,
        status: "done",
        at: context.env.now(),
      });
      await context.driver.drain("run");
      expect(progress(context.state()).phase).toBe("cancelled");
      expect(context.fake.sessions.get(planner.id)?.stopped).toBe(true);
      context.store.delete("run");
      expect(context.store.load("run")).toBeNull();
    } finally {
      context.close();
    }
  },
);

it("a full control outbox still admits cancellation and drains terminal cleanup", async () => {
  const context = fixture();
  try {
    await context.driver.drain("run");
    const db = new DatabaseSync(context.path);
    try {
      db.exec("BEGIN");
      const insert = db.prepare("INSERT INTO conductor_outbox(run,id,payload) VALUES (?,?,?)");
      for (let i = 0; i < 2048; i++)
        insert.run(
          "run",
          `close-${i}`,
          JSON.stringify({ type: "gate_closed", id: `close-${i}`, gateId: `gate-${i}` }),
        );
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    context.driver.command("cancel", { type: "conductor.cancel", runId: "run" });
    while (await context.driver.drain("run", 1024)) {
      /* bounded batches, no time polling */
    }
    expect(progress(context.state()).phase).toBe("cancelled");
    expect(context.store.pending("run")).toEqual([]);
    context.store.delete("run");
    expect(context.store.load("run")).toBeNull();
  } finally {
    context.close();
  }
});
