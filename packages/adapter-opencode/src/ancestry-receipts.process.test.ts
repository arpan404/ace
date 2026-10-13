import { expect, it } from "vitest";
import { ThreadId } from "@ace/protocol";
import { maxProviderPayloadBytes } from "@ace/provider-kit/payload";
import { setup } from "./testing/v2-session.ts";
import { object } from "./data.ts";

it("a near-limit native receipt preserves its evidence and leaves room for the next child's lookup", async () => {
  const h = await setup();
  // The root has already finished a turn, so a settled tree reads as done rather than new.
  await h.publish("session.execution.started");
  await h.publish("session.execution.succeeded");
  const child = (id: string) => ({
    id,
    parentID: h.session.nativeSessionId,
    projectID: "project-one",
    location: { directory: "/one" },
    time: { updated: 100, idle: 100 },
  });
  await h.control("/test/state", {
    sessions: [child("large-child"), child("next-child")],
  });
  const native = {
    id: "near-limit-receipt",
    created: 1,
    type: "future.opaque-receipt",
    data: { sessionID: "large-child", vendor: { opaque: "" } },
    location: { directory: "/one" },
  };
  native.data.vendor.opaque = "x".repeat(
    maxProviderPayloadBytes - 16 - Buffer.byteLength(JSON.stringify(native)),
  );
  const from = h.frames.length;
  await h.control("/test/events", [
    {
      type: native.type,
      data: native.data,
      directory: "/one",
      extra: { id: native.id, created: native.created },
    },
  ]);
  await h.seen((frame) => frame.channel === "sse" && object(frame.data).id === native.id, from);
  await h.seen(
    (frame) => frame.channel === "lifecycle" && object(frame.data).type === "ancestry.settled",
    from,
  );
  const translator = h.adapter.createTranslator({
    threadId: ThreadId.parse("bounded-native-receipts"),
    rootKey: "root",
  });
  const receipts = h.frames.slice(from).flatMap((frame) => {
    translator.translate(frame, frame.t);
    return frame.channel === "ancestry.buffered" ? (translator.takeDiagnostics?.() ?? []) : [];
  });
  expect(
    receipts.some(
      (receipt) => "data" in receipt && JSON.stringify(receipt.data) === JSON.stringify(native),
    ),
  ).toBe(true);
  expect(h.projection.view.thread.status.state).toBe("done");
  const next = h.frames.length;
  await h.control("/test/events", [
    { type: "future.next-child", directory: "/one", data: { sessionID: "next-child" } },
  ]);
  await h.seen(
    (frame) =>
      frame.dir === "recv" &&
      frame.channel === "http" &&
      object(frame.data).path === "/api/session/next-child",
    next,
  );
  await h.seen(
    (frame) => frame.channel === "sse" && object(frame.data).type === "future.next-child",
    next,
  );
  expect(h.projection.view.thread.status.state).toBe("done");
});

it.each(["ancestry.buffered", "lifecycle"])(
  "a throwing %s frame callback releases unknown-event admission and any pending guard",
  async (channel) => {
    let rejectFrame = true;
    const h = await setup({}, (frame) => {
      if (
        rejectFrame &&
        frame.channel === channel &&
        (channel !== "lifecycle" || object(frame.data).type === "ancestry.pending")
      ) {
        rejectFrame = false;
        throw new Error("receipt sink temporarily unavailable");
      }
    });
    // The root has already finished a turn, so a settled tree reads as done rather than new.
    await h.publish("session.execution.started");
    await h.publish("session.execution.succeeded");
    const from = h.frames.length;
    await h.control("/test/events", [
      {
        type: "future.failed-receipt",
        directory: "/one",
        data: { sessionID: "absent-child", vendor: "x".repeat(1024 * 1024 - 1024) },
      },
    ]);
    await h.recovered(from);
    expect(rejectFrame).toBe(false);
    expect(h.projection.view.thread.status.state).toBe("done");
    await h.control("/test/state", {
      sessions: [
        {
          id: "next-child",
          parentID: h.session.nativeSessionId,
          projectID: "project-one",
          location: { directory: "/one" },
          time: { updated: 100, idle: 100 },
        },
      ],
    });
    const next = h.frames.length;
    await h.control("/test/events", [
      {
        type: "future.next-child",
        directory: "/one",
        data: { sessionID: "next-child", vendor: "y".repeat(2048) },
      },
    ]);
    await h.seen(
      (frame) =>
        frame.dir === "recv" &&
        frame.channel === "http" &&
        object(frame.data).path === "/api/session/next-child",
      next,
    );
    await h.seen(
      (frame) => frame.channel === "sse" && object(frame.data).type === "future.next-child",
      next,
    );
    expect(h.projection.view.thread.status.state).toBe("done");
  },
);
