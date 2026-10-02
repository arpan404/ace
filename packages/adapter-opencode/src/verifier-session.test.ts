import { expect, it } from "vitest";
import { readSse } from "@ace/provider-kit/sse";
import { object } from "./data.ts";
import { setup } from "./testing/session-harness.ts";

it("holds delivery when newer busy SSE arrives while an older idle snapshot is in flight", async () => {
  let statuses = 0;
  let holding = false;
  const { promise: held, resolve: reached } = Promise.withResolvers<void>();
  const { promise: newerEvent, resolve: observed } = Promise.withResolvers<void>();
  const { promise: delivery, resolve: release } = Promise.withResolvers<void>();
  const h = await setup({
    runtime: {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (new URL(String(input)).pathname === "/session/status" && ++statuses === 2) {
          const snapshot = await response.text();
          holding = true;
          reached();
          await delivery;
          return new Response(snapshot, { status: response.status, headers: response.headers });
        }
        return response;
      },
      stream: (url, options) =>
        readSse(url, {
          ...options,
          onEvent: (event) => {
            options.onEvent(event);
            const payload = object(object(JSON.parse(event.data)).payload);
            if (
              holding &&
              payload.type === "session.status" &&
              object(object(payload.properties).status).type === "busy"
            )
              observed();
          },
        }),
    },
  });
  const id = h.session.nativeSessionId;
  await h.session.send([{ type: "text", text: "first" }], "queue");
  await h.control("/test/state", {
    statuses: { [id]: { type: "idle" } },
    onMessage: {
      directory: "/one",
      payload: { type: "future.event", properties: { sessionID: id } },
    },
  });
  await h.control("/test/drop", {});
  await held;
  await h.control("/test/state", { statuses: { [id]: { type: "busy" } } });
  await h.publish("session.status", { sessionID: id, status: { type: "busy" } });
  await newerEvent;
  release();
  await h.wait((frame) => frame.channel === "lifecycle" && object(frame.data).type === "resynced");
  const recovered = h.projection.view.thread.status.state;
  const queued = h.session.send([{ type: "text", text: "second" }], "queue");
  void queued.catch(() => {});
  await h.session.resolve("barrier", { kind: "approval", optionId: "once" });
  const sent = h.frames.filter(
    (frame) => frame.dir === "send" && String(object(frame.data).path).endsWith("/prompt_async"),
  );
  expect({ recovered, accepted: sent.length }).toEqual({ recovered: "working", accepted: 1 });
  await h.publish("session.status", { sessionID: id, status: { type: "idle" } });
  await queued;
});
