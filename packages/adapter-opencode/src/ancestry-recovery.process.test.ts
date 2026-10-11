import { expect, it } from "vitest";
import { setup, deferred } from "./testing/v2-session.ts";
import { object } from "./data.ts";

it.each(["permission.asked", "session.execution.started"])(
  "recovery settles deferred %s when authoritative child snapshots show no remaining work",
  async (type) => {
    const entered = deferred<void>(),
      release = deferred<void>();
    let failed = false;
    const h = await setup({
      runtime: {
        fetch: async (input, init) => {
          if (String(input).endsWith("/api/session/settled-child") && !failed) {
            failed = true;
            entered.resolve();
            await release.promise;
            throw new Error("temporary ancestry lookup failure");
          }
          return fetch(input, init);
        },
      },
    });
    try {
      await h.publish("session.execution.started");
      await h.control("/test/state", {
        sessions: [
          {
            id: "settled-child",
            parentID: h.session.nativeSessionId,
            projectID: "project-one",
            location: { directory: "/one" },
            time: { updated: 2, idle: 2 },
          },
        ],
        permissions: [],
        active: {},
      });
      await h.control("/test/events", [
        {
          type,
          directory: "/one",
          data: { sessionID: "settled-child", id: "settled-ask", action: "edit", resources: ["x"] },
        },
      ]);
      await entered.promise;
      await h.publish("session.execution.succeeded");
      expect(h.projection.view.thread.status.state).not.toBe("done");
      const recovered = h.recovered();
      release.resolve();
      await recovered;
      expect(
        Object.values(h.projection.view.agents).map((agent) => agent.native.nativeId),
      ).toContain("settled-child");
      expect(h.projection.view.thread.status.state).toBe("done");
      expect(
        Object.values(h.projection.view.interactions).some((value) => value.state === "pending"),
      ).toBe(false);
      await h.session.send([{ type: "text", text: "usable after settlement" }], "queue");
    } finally {
      release.resolve();
    }
  },
);

it("new child work received during recovery survives older idle snapshots and deferred starts", async () => {
  const held = deferred<void>(),
    release = deferred<void>();
  let failed = false,
    shellReads = 0;
  const h = await setup({
    runtime: {
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/session/restarted-child" && !failed) {
          failed = true;
          throw new Error("temporary ancestry lookup failure");
        }
        const response = await fetch(input, init);
        if (path === "/api/shell" && ++shellReads === 2) {
          const body = await response.text();
          held.resolve();
          await release.promise;
          return new Response(body, { status: response.status, headers: response.headers });
        }
        return response;
      },
    },
  });
  try {
    await h.publish("session.execution.started");
    await h.control("/test/state", {
      sessions: [
        {
          id: h.session.nativeSessionId,
          projectID: "project-one",
          location: { directory: "/one" },
          time: { updated: 3, idle: 3 },
        },
        {
          id: "restarted-child",
          parentID: h.session.nativeSessionId,
          projectID: "project-one",
          location: { directory: "/one" },
          time: { updated: 2, idle: 2 },
        },
      ],
      permissions: [],
      active: {},
    });
    const recovered = h.recovered();
    await h.control("/test/events", [
      {
        type: "session.execution.started",
        directory: "/one",
        data: { sessionID: "restarted-child" },
      },
    ]);
    await held.promise;
    await h.control("/test/events", [
      {
        type: "session.execution.started",
        directory: "/one",
        data: { sessionID: "restarted-child" },
      },
    ]);
    await h.seen(
      (frame) =>
        frame.channel === "recovery.buffered" &&
        object(frame.data).type === "session.execution.started",
    );
    release.resolve();
    await recovered;
    expect(h.projection.view.thread.status.state).toBe("working");
    expect(Object.values(h.projection.view.runs).some((run) => run.state === "active")).toBe(true);
    await h.publish("session.execution.succeeded", { sessionID: "restarted-child" });
    expect(h.projection.view.thread.status.state).toBe("done");
  } finally {
    release.resolve();
  }
});
