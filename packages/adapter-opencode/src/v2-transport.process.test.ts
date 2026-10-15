import { expect, it } from "vitest";
import { setup, Clock } from "./testing/v2-session.ts";
import { array, object } from "./data.ts";
it("oversized projected content fails recovery before truncation can hide a live tool", async () => {
  const h = await setup();
  await h.publish("session.execution.started");
  await h.control("/test/state", {
    messages: {
      [h.session.nativeSessionId]: [
        {
          id: "oversized",
          type: "assistant",
          content: [
            ...Array.from({ length: 2048 }, () => ({ type: "text", text: "history" })),
            { type: "tool", id: "live", name: "shell", state: { status: "running", input: {} } },
          ],
        },
      ],
    },
  });
  const exited = h.seen(
    (frame) => frame.channel === "lifecycle" && object(frame.data).type === "exited",
  );
  await h.control("/test/drop", {});
  await exited;
  expect(h.projection.view.thread.status.state).not.toBe("done");
});
it.each(["data: {bad json}\n\n", `data: ${"x".repeat(1024 * 1024 + 1)}\n\n`])(
  "malformed or oversized SSE triggers bounded snapshot recovery",
  async (raw) => {
    const h = await setup(),
      recovery = h.recovered();
    await h.control("/test/events", [{ raw }]);
    await recovery;
    expect(h.projection.view.thread.status.state).toBe("new");
    expect(
      array(await h.control("/test/requests"))
        .map(object)
        .some((r) => r.path === "/api/session/active"),
    ).toBe(true);
  },
);
it("comment-only keepalives renew transport liveness without marking an idle agent working", async () => {
  const clock = new Clock(),
    h = await setup({ runtime: { monotonic: () => clock.now, schedule: clock.schedule } });
  clock.advance(24000);
  const from = h.frames.length;
  await h.control("/test/events", [{ raw: ": heartbeat\n\n" }]);
  await h.seen((f) => f.channel === "transport.activity", from);
  clock.advance(2000);
  await h.publish("session.execution.started");
  await h.publish("session.execution.succeeded");
  expect(await h.control("/test/connections")).toBe(1);
  expect(h.projection.view.thread.status.state).toBe("done");
});

it("a recovery buffer overflow restarts the resync and keeps the session and its pending question", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  const ask = { sessionID: root, id: "pending", action: "edit", resources: ["x"] };
  await h.publish("session.execution.started");
  await h.publish("permission.asked", { id: "pending", action: "edit", resources: ["x"] });
  await h.control("/test/state", {
    active: { [root]: { type: "running" } },
    permissions: [ask],
    fault: { holdHistory: true },
  });
  const from = h.frames.length;
  await h.control("/test/drop", {});
  await h.seen(
    (f) =>
      f.dir === "send" &&
      String(object(f.data).path).split("?")[0] === `/api/session/${root}/message`,
    from,
  );
  await h.control(
    "/test/events",
    Array.from({ length: 4097 }, () => ({
      type: "session.text.delta",
      directory: "/one",
      data: { sessionID: root, assistantMessageID: "a", ordinal: 0, delta: "x" },
    })),
  );
  await h.seen((f) => f.channel === "recovery.restarted", from);
  const recovered = h.recovered(h.frames.length);
  await h.control("/test/release", {});
  await recovered;
  expect(h.exits).toEqual([]);
  expect(Object.values(h.projection.view.interactions)[0]?.state).toBe("pending");
  expect(h.projection.view.thread.status.state).toBe("needs_you");
});

it("OpenCode sessions survive a resync slower than 30 seconds", async () => {
  const clock = new Clock(),
    h = await setup({ runtime: { monotonic: () => clock.now, schedule: clock.schedule } }),
    root = h.session.nativeSessionId;
  await h.publish("session.execution.started");
  await h.control("/test/state", {
    active: { [root]: { type: "running" } },
    fault: { holdHistory: true },
  });
  const from = h.frames.length;
  let resynced = false;
  void h.recovered(from).then(() => (resynced = true));
  await h.control("/test/drop", {});
  for (let step = 0; step < 50; step++) {
    clock.advance(100);
    if (
      h.frames
        .slice(from)
        .some(
          (f) =>
            f.dir === "send" &&
            String(object(f.data).path).includes(`/api/session/${root}/message`),
        )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The history read is held past the 30 second mark; recovery retries instead of giving up.
  clock.advance(31_000);
  for (let step = 0; step < 200; step++) {
    if (resynced) break;
    clock.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(resynced).toBe(true);
  expect(h.exits).toEqual([]);
  expect(h.projection.view.thread.status.state).toBe("working");
  await h.publish("session.execution.succeeded");
  expect(h.projection.view.thread.status.state).toBe("done");
});

it("recovery ends only the session OpenCode no longer has and keeps the others", async () => {
  const h = await setup();
  const other = await h.open("/one");
  await h.control("/test/state", { deleted: [other.nativeSessionId] });
  const recovered = h.recovered();
  await h.control("/test/drop", {});
  await recovered;
  expect(h.exits).toEqual([
    { deliberate: false, message: "OpenCode could not restore this session" },
  ]);
  await h.publish("session.execution.started");
  await h.publish("session.execution.succeeded");
});

it("a dropped local stream recovers without replaying a prompt and native progress releases its upstream retry", async () => {
  const h = await setup();
  const sessionID = h.session.nativeSessionId;
  await h.publish("session.execution.started");
  await h.publish("session.retry.scheduled", {
    attempt: 2,
    at: 2000,
    error: { message: "ECONNRESET: socket closed unexpectedly" },
  });
  expect(h.projection.view.thread.status).toEqual({ state: "waiting", on: "network" });
  await h.control("/test/state", { active: { [sessionID]: { type: "running" } } });
  const recovered = h.recovered();
  await h.control("/test/drop", {});
  await recovered;
  expect(h.projection.view.thread.status).toEqual({ state: "waiting", on: "network" });
  await h.publish("session.text.delta", {
    assistantMessageID: "resumed",
    ordinal: 0,
    delta: "Recovered",
  });
  expect(h.projection.view.thread.status.state).toBe("working");
  expect(
    array(await h.control("/test/requests"))
      .map(object)
      .filter((request) => String(request.path).endsWith("/prompt")),
  ).toHaveLength(0);
  await h.publish("session.execution.succeeded");
  expect(h.projection.view.thread.status.state).toBe("done");
});
