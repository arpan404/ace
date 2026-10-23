import { expect, test } from "vitest";
import { FakeDaemon, facts, fakeTransport } from "./index.ts";
import { previewUnits } from "./window.ts";

/*
 * A thread that has streamed for hours opens like a new one: as the daemon does, a snapshot
 * carries a bounded preview of a long text, and a subscriber far behind gets a snapshot instead
 * of every event since. Over the raw wire, as a client sees it.
 */

function connect(daemon: FakeDaemon) {
  const received: Record<string, unknown>[] = [];
  const frames: string[] = [];
  const transport = fakeTransport(daemon);
  transport.open({
    open: () => {},
    message: (text: string) => {
      frames.push(text);
      received.push(JSON.parse(text) as Record<string, unknown>);
    },
    close: () => {},
  });
  transport.send(
    JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: "phone", token: daemon.token }),
  );
  const subscribe = (subscriptionId: string, afterSeq?: number) =>
    transport.send(
      JSON.stringify({
        type: "subscribe",
        subscriptionId,
        scope: { kind: "thread", threadId: "long" },
        ...(afterSeq === undefined ? {} : { afterSeq }),
      }),
    );
  return { received, frames, subscribe };
}

function streamed(daemon: FakeDaemon, deltas: number, piece: string) {
  daemon.createThread({ id: "long", workspaceId: "ace", title: "Long", provider: "codex" });
  daemon.apply("long", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "stream", "assistant", "Start", false),
  ]);
  for (let start = 0; start < deltas; start += 1000)
    daemon.apply(
      "long",
      Array.from({ length: Math.min(1000, deltas - start) }, () =>
        facts.stream("root", "stream", piece),
      ),
    );
}

test("a message streamed past the wire's frame size opens with a bounded preview of its newest text", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  // 3 MB of text: one frame of it would exceed the 2 MiB a client accepts.
  streamed(daemon, 3_000, "z".repeat(1000));
  const wire = connect(daemon);
  wire.subscribe("first");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const snapshot = wire.received.find((message) => message.type === "snapshot");
  expect(snapshot).toBeDefined();
  expect(Math.max(...wire.frames.map((frame) => frame.length))).toBeLessThan(1024 * 1024);
  const view = snapshot?.view as {
    items: Record<string, { parts: { text: string; source?: { bytes: number } }[] }>;
  };
  const message = Object.values(view.items).find((item) => item.parts?.[0]?.text.startsWith("z"));
  expect(message?.parts[0]?.text.length).toBe(previewUnits);
  expect(message?.parts[0]?.source?.bytes).toBe((5 + 3_000_000) * 2);
});

test("a subscriber further behind than the daemon replays gets a snapshot, not every event since", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  streamed(daemon, 6_000, "x");
  const wire = connect(daemon);
  wire.subscribe("behind", 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(wire.received.some((message) => message.type === "snapshot")).toBe(true);
  const replayed = wire.received
    .filter((message) => message.type === "events")
    .reduce((sum, message) => sum + ((message.events as unknown[] | undefined)?.length ?? 0), 0);
  expect(replayed).toBe(0);
});
