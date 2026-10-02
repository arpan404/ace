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
          call: expect.objectContaining({ status: "cancelled", endedAt: 200 }),
        }),
      }),
    );
    expect(h.item("old-shell")).toMatchObject({ call: { status: "cancelled", endedAt: 200 } });
    expect(h.task("old-task")?.status).toBe("unknown");
    expect(h.send({ type: "process.exited", deliberate }, 250)).toEqual([]);
    expect(h.item("old-shell")).toMatchObject({ call: { endedAt: 200 } });
    h.send({ type: "process.started" }, 251);
    h.start("root", "replacement");
    expect(nextDeadline(h.state)).toBe(263);
    expect(h.send({ type: "tick" }, 1000)).toContainEqual({
      type: "thread.updated",
      status: { state: "unresponsive" },
    });
    expect(h.agent("root")?.status).toEqual({ state: "unresponsive", lastSignalAt: 252 });
  },
);
