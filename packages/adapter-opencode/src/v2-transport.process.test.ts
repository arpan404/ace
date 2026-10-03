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
    expect(h.projection.view.thread.status.state).toBe("done");
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

it("recovery overflow closes the owned lease and expires interactions without reporting completed work", async () => {
  const h = await setup(),
    root = h.session.nativeSessionId;
  await h.publish("session.execution.started");
  await h.publish("permission.asked", { id: "pending", action: "edit", resources: ["x"] });
  await h.control("/test/state", { fault: { holdHistory: true } });
  const from = h.frames.length;
  await h.control("/test/drop", {});
  await h.seen(
    (f) =>
      f.dir === "send" &&
      String(object(f.data).path).split("?")[0] === `/api/session/${root}/message`,
    from,
  );
  const exited = h.seen((f) => f.channel === "lifecycle" && object(f.data).type === "exited", from);
  await h.control(
    "/test/events",
    Array.from({ length: 4097 }, () => ({
      type: "session.text.delta",
      directory: "/one",
      data: { sessionID: root, assistantMessageID: "a", ordinal: 0, delta: "x" },
    })),
  );
  await exited;
  expect(h.projection.view.thread.status.state).not.toBe("done");
  expect(Object.values(h.projection.view.interactions)[0]?.state).toBe("expired");
});
