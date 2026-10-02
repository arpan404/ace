import { expect, it } from "vitest";
import { nextDeadline } from "./index.ts";
import { harness } from "./test-helper.ts";

it.each([false, true])(
  "dead tools from an ended turn cannot hide silence after a deliberate=%s restart",
  (deliberate) => {
    const h = harness("codex", { silenceMs: 10 });
    h.start();
    h.background("old-task", "old-shell");
    h.end();
    const exited = h.send({ type: "process.exited", deliberate }, 200);
    expect(exited).toContainEqual(
      expect.objectContaining({
        type: "item.updated",
        item: expect.objectContaining({
          complete: true,
          call: expect.objectContaining({ status: "cancelled" }),
        }),
      }),
    );
    expect(h.task("old-task")?.status).toBe("unknown");
    h.send({ type: "process.started" }, 201);
    h.start("root", "replacement");
    expect(nextDeadline(h.state)).toBe(213);
    expect(h.send({ type: "tick" }, 1000)).toContainEqual({
      type: "thread.updated",
      status: { state: "unresponsive" },
    });
    expect(h.agent("root")?.status).toEqual({ state: "unresponsive", lastSignalAt: 202 });
  },
);
