import { expect, test } from "vitest";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { setup } from "./translator.test-helper.ts";

const message = (id: string, text: string) => ({ type: "agentMessage", id, text });

test("a history read split across frozen notes joins the turn's items in order", () => {
  const h = setup();
  let seq = 100;
  // Live notes arrive as ProviderPayload data, which is frozen.
  const note = (data: unknown) => {
    const payload = new ProviderPayload(JSON.stringify(data));
    h.feed({ seq: ++seq, t: seq, dir: "note", channel: "stdio", data: payload.data, payload });
  };
  note({
    event: "thread-history",
    threadId: "native",
    read: 1,
    turns: [{ id: "earlier", status: "completed", items: [message("first", "one")] }],
  });
  note({
    event: "thread-history",
    threadId: "native",
    read: 1,
    turns: [{ id: "earlier", status: "completed", items: [message("second", "two")] }],
  });
  note({
    event: "thread-discovered",
    history: 1,
    revision: { read: 1, current: 1 },
    thread: { id: "native", status: { type: "idle" }, turns: [] },
  });
  const texts = h.events.flatMap((event) =>
    event.type === "item.created" && event.item.type === "message"
      ? event.item.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
  expect(texts).toEqual(["one", "two"]);
});
