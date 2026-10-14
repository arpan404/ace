import { expect, it } from "vitest";
import { setup } from "./testing/v2-session.ts";
import { array, object } from "./data.ts";

// 3 MiB of image bytes is 4 MiB of base64: past every per-frame and per-page bound.
const image = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64");
const readResult = (path: string) => ({
  status: "completed",
  input: { path },
  content: [
    { type: "text", text: "Image read successfully" },
    { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: path },
  ],
});

it("a thread whose history holds a multi-megabyte image reopens, streams a turn and takes a follow-up", async () => {
  const h = await setup();
  const source = await h.open("/two");
  const native = source.nativeSessionId;
  await source.close("idle");
  await h.control("/test/state", {
    messages: {
      [native]: [
        {
          id: "m-user",
          type: "user",
          time: { created: 1 },
          text: "when will this apple man reach his destination?",
          files: [
            {
              data: image,
              mime: "image/png",
              source: { type: "uri", uri: "file:///tmp/apple.png" },
              name: "apple.png",
            },
          ],
        },
        {
          id: "m-assistant",
          type: "assistant",
          time: { created: 2, completed: 3 },
          content: [
            { type: "text", text: "Looking at the image." },
            {
              type: "tool",
              id: "read-1",
              name: "read",
              time: { created: 2, completed: 3 },
              state: readResult("/tmp/apple.png"),
            },
          ],
        },
      ],
    },
  });
  const resumed = await h.open("/two", native);
  try {
    const history = h.frames
      .filter((f) => f.channel === "snapshot.message" && object(f.data).sessionID === native)
      .map((f) => f.data);
    expect(history.map((data) => object(object(data).message).id).toSorted()).toEqual([
      "m-assistant",
      "m-user",
    ]);
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain(image.slice(0, 32 * 1024));
    expect(serialized).toContain("bytes of data:image/png;base64 elided");
    expect(serialized).toContain("bytes of base64 data elided");

    const event = (type: string, data: Record<string, unknown> = {}) => ({
      type,
      directory: "/two",
      data: { sessionID: native, ...data },
    });
    await h.control("/test/events", [
      event("session.execution.started"),
      event("session.tool.success", {
        assistantMessageID: "m-next",
        id: "read-2",
        name: "read",
        state: readResult("/tmp/apple.png"),
      }),
      event("session.execution.succeeded"),
    ]);
    await h.seen(
      (f) =>
        f.channel === "sse" &&
        object(f.data).type === "session.execution.succeeded" &&
        object(object(f.data).data).sessionID === native,
    );

    await resumed.send([{ type: "text", text: "you failed?" }], "queue");
    const prompts = array(await h.control("/test/requests"))
      .map(object)
      .filter((r) => r.path === `/api/session/${native}/prompt`);
    expect(prompts.map((r) => object(r.body).text)).toEqual(["you failed?"]);
    expect(h.frames.some((f) => f.channel === "input.rejected")).toBe(false);
  } finally {
    await resumed.close("shutdown");
  }
});

it("a single event carrying a multi-megabyte image is elided without dropping the stream", async () => {
  const h = await setup();
  await h.publish("session.execution.started");
  const from = h.frames.length;
  await h.publish("session.tool.success", {
    assistantMessageID: "a",
    id: "read",
    name: "read",
    state: readResult("/tmp/apple.png"),
  });
  await h.publish("session.execution.succeeded");
  const later = h.frames.slice(from);
  expect(
    later.some((f) => f.channel === "lifecycle" && object(f.data).type === "disconnected"),
  ).toBe(false);
  expect(await h.control("/test/connections")).toBe(1);
  expect(JSON.stringify(later.map((f) => f.data))).not.toContain(image.slice(0, 32 * 1024));
  expect(
    Object.values(h.projection.view.items)
      .filter((item) => item.type === "tool_call")
      .map((item) => item.call.status),
  ).toEqual(["succeeded"]);
  expect(h.projection.view.thread.status.state).toBe("done");
});
