import { expect, it } from "vitest";
import { setup, deferred } from "./testing/v2-session.ts";

it.each(["missing", "exited", "running"])(
  "deferred running shell evidence follows authoritative %s shell state after recovery",
  async (status) => {
    const entered = deferred<void>(),
      release = deferred<void>();
    let failed = false;
    const h = await setup({
      runtime: {
        fetch: async (input, init) => {
          if (new URL(String(input)).pathname === "/api/session/shell-child" && !failed) {
            failed = true;
            entered.resolve();
            await release.promise;
            throw new Error("temporary ancestry lookup failure");
          }
          return fetch(input, init);
        },
      },
    });
    const shell = {
      id: "deferred-shell",
      cwd: "/one",
      status: "running",
      metadata: { sessionID: "shell-child" },
    };
    try {
      await h.publish("session.execution.started");
      await h.control("/test/state", {
        sessions: [
          {
            id: "shell-child",
            parentID: h.session.nativeSessionId,
            projectID: "project-one",
            location: { directory: "/one" },
            time: { updated: 100, idle: 100 },
          },
        ],
        shells: [shell],
      });
      await h.control("/test/events", [
        { type: "shell.created", directory: "/one", data: { info: shell } },
      ]);
      await entered.promise;
      await h.publish("session.execution.succeeded");
      await h.control("/test/state", {
        shells:
          status === "missing" ? [] : [{ ...shell, status, exit: 0, time: { completed: 100 } }],
      });
      const recovered = h.recovered();
      release.resolve();
      await recovered;
      if (status === "running") {
        expect(h.projection.view.thread.status).toMatchObject({
          state: "waiting",
          on: "background_task",
        });
        expect(
          Object.values(h.projection.view.backgroundTasks).filter(
            (task) => task.status === "running",
          ),
        ).toHaveLength(1);
        await h.publish("shell.exited", { id: shell.id, exit: 0, time: { completed: 101 } });
      }
      expect(h.projection.view.thread.status.state).toBe("done");
      expect(
        Object.values(h.projection.view.backgroundTasks).some((task) => task.status === "running"),
      ).toBe(false);
      await h.session.send(
        [{ type: "text", text: "deliverable after shell reconciliation" }],
        "queue",
      );
    } finally {
      release.resolve();
    }
  },
);
