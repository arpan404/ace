import { expect, it } from "vitest";
import { setup, deferred } from "./testing/v2-session.ts";
import { object } from "./data.ts";

it.each(["permission.asked", "session.execution.started"])(
  "recovery consumes a held successful probe's obsolete %s before and after its GET returns",
  async (type) => {
    const entered = deferred<void>(),
      release = deferred<void>();
    let held = false;
    const h = await setup({
      runtime: {
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (new URL(String(input)).pathname === "/api/session/held-child" && !held) {
            held = true;
            const body = await response.text();
            entered.resolve();
            await release.promise;
            return new Response(body, { status: response.status, headers: response.headers });
          }
          return response;
        },
      },
    });
    const child = {
      id: "held-child",
      parentID: h.session.nativeSessionId,
      projectID: "project-one",
      location: { directory: "/one" },
    };
    try {
      await h.publish("session.execution.started");
      await h.control("/test/state", { sessions: [{ ...child, time: { updated: 1 } }] });
      await h.control("/test/events", [
        {
          type,
          directory: "/one",
          data: { sessionID: child.id, id: "old-permission", action: "edit", resources: ["x"] },
        },
      ]);
      await entered.promise;
      await h.control("/test/state", {
        sessions: [{ ...child, time: { updated: 100, idle: 100 } }],
        permissions: [],
        active: {},
      });
      await h.publish("session.execution.succeeded");
      const recovered = h.recovered();
      await h.control("/test/drop", {});
      await recovered;
      expect(h.projection.view.thread.status.state).toBe("done");
      const from = h.frames.length;
      release.resolve();
      await h.seen(
        (frame) =>
          frame.dir === "recv" &&
          frame.channel === "http" &&
          object(frame.data).path === "/api/session/held-child",
        from,
      );
      await h.publish("future.probe-returned");
      expect(h.projection.view.thread.status.state).toBe("done");
      expect(
        Object.values(h.projection.view.interactions).some((value) => value.state === "pending"),
      ).toBe(false);
      expect(Object.values(h.projection.view.runs).some((run) => run.state === "active")).toBe(
        false,
      );
      await h.session.send([{ type: "text", text: "still usable after probe returns" }], "queue");
    } finally {
      release.resolve();
    }
  },
);

it("a successful probe returning during recovery waits for authoritative settlement", async () => {
  const entered = deferred<void>(),
    releaseProbe = deferred<void>(),
    snapshotsRead = deferred<void>(),
    releaseSnapshots = deferred<void>();
  let held = false,
    shellReads = 0;
  const h = await setup({
    runtime: {
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const response = await fetch(input, init);
        if (path === "/api/session/held-child" && !held) {
          held = true;
          const body = await response.text();
          entered.resolve();
          await releaseProbe.promise;
          return new Response(body, { status: response.status, headers: response.headers });
        }
        if (path === "/api/shell" && ++shellReads === 2) {
          const body = await response.text();
          snapshotsRead.resolve();
          await releaseSnapshots.promise;
          return new Response(body, { status: response.status, headers: response.headers });
        }
        return response;
      },
    },
  });
  // The root has already finished a turn, so a settled tree reads as done rather than new.
  await h.publish("session.execution.started");
  await h.publish("session.execution.succeeded");
  const child = {
    id: "held-child",
    parentID: h.session.nativeSessionId,
    projectID: "project-one",
    location: { directory: "/one" },
  };
  try {
    await h.control("/test/state", { sessions: [{ ...child, time: { updated: 100, idle: 100 } }] });
    await h.control("/test/events", [
      {
        type: "session.execution.started",
        directory: "/one",
        data: { sessionID: child.id },
      },
    ]);
    await entered.promise;
    const recovered = h.recovered();
    await h.control("/test/drop", {});
    await snapshotsRead.promise;
    const from = h.frames.length;
    releaseProbe.resolve();
    await h.seen(
      (frame) =>
        frame.dir === "recv" &&
        frame.channel === "http" &&
        object(frame.data).path === "/api/session/held-child",
      from,
    );
    // A real HTTP round trip drains the returned GET's Promise callbacks before finalization.
    await h.control("/test/requests");
    releaseSnapshots.resolve();
    await recovered;
    expect(h.projection.view.thread.status.state).toBe("done");
    expect(Object.values(h.projection.view.runs).some((run) => run.state === "active")).toBe(false);
  } finally {
    releaseProbe.resolve();
    releaseSnapshots.resolve();
  }
});
