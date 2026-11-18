import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { AgentId, ServerMessage, ThreadId, type McpAttribution } from "@ace/protocol";
import { SuitPreviews } from "@ace/mcp-server";
import { SuitServerMessage } from "@ace/protocol/suits";
import { expect, test } from "vitest";
import { setup } from "./remote-test-support.ts";
import { SuitLibrary } from "./suits/library.ts";
import { SuitLooks } from "./suits/looks.ts";
import { daemonSuitPort } from "./suits/port.ts";
import { nodeSuitSchedule, nodeSuitWatch } from "./suits/watch.ts";

/*
 * Real paired-device sockets: scope checks, the change push and which devices hear an agent's
 * `suit_apply` are wiring a unit test of the library or the hub can't reach.
 */
const frame = z.union([ServerMessage, SuitServerMessage]);
type Frame = z.infer<typeof frame>;

type Fixture = Awaited<ReturnType<typeof setup>>;

/** A paired device's socket, welcomed, with its frames to wait on and its Suit requests. */
async function connect(f: Fixture, sockets: WebSocket[], scopes: string[]) {
  const device = await f.pair(scopes);
  const ticket = await f.ticket(device.token);
  const socket = new WebSocket(f.server.url);
  sockets.push(socket);
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (data) => {
    frames.push(frame.parse(JSON.parse(String(data))));
    for (const wake of waiters.splice(0)) wake();
  });
  const next = async (match: (message: Frame) => boolean): Promise<Frame> => {
    for (;;) {
      const found = frames.findIndex(match);
      if (found >= 0) return frames.splice(found, 1)[0]!;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      deviceId: device.device.id,
      ticket: ticket.ticket,
    }),
  );
  await next((message) => message.type === "welcome");
  const request = (requestId: string, body: unknown) => {
    socket.send(JSON.stringify({ type: "suitRequest", requestId, request: body }));
    return next((message) => "requestId" in message && message.requestId === requestId);
  };
  /** The next look the daemon sends this device. */
  const active = async () => {
    const message = await next((candidate) => candidate.type === "suitActive");
    return message.type === "suitActive" ? message.active : undefined;
  };
  /** Asks to hear the agent's looks on this socket (`suitWatch`). */
  const watch = () => socket.send(JSON.stringify({ type: "suitWatch", requestId: "watch" }));
  /** Nothing more for this device after a round trip the socket answers in order. */
  const quiet = async (requestId: string) => {
    await request(requestId, { op: "list" });
    return frames.filter((message) => message.type === "suitActive");
  };
  return { id: device.device.id, request, next, active, quiet, watch };
}

function library(root: string) {
  return new SuitLibrary({
    root,
    key: new Uint8Array(32),
    watch: nodeSuitWatch,
    schedule: nodeSuitSchedule,
    settleMs: 20,
  });
}

test("a read device lists Suits and hears removals, but only an admin device removes one", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-suit-scopes-")));
  const root = join(home, "suits");
  await mkdir(join(root, "neon"), { recursive: true });
  await writeFile(
    join(root, "neon", "suit.json"),
    JSON.stringify({ format: 1, id: "neon", name: "Neon", dark: {} }),
  );
  const suits = library(root);
  await suits.start();
  const sockets: WebSocket[] = [];
  try {
    const f = await setup({ suits });
    const connectAs = (scopes: string[]) => connect(f, sockets, scopes);

    const reader = await connectAs(["read"]);
    expect(await reader.request("list", { op: "list" })).toMatchObject({
      type: "suitResult",
      response: { op: "list", suits: [{ id: "neon", problems: [] }] },
    });
    expect(await reader.request("remove", { op: "remove", id: "neon" })).toMatchObject({
      response: { op: "error", code: "forbidden" },
    });
    expect((await stat(join(root, "neon"))).isDirectory()).toBe(true);

    const admin = await connectAs(["admin"]);
    expect(await admin.request("remove", { op: "remove", id: "neon" })).toMatchObject({
      response: { op: "remove", removed: true },
    });
    expect(await reader.next((message) => message.type === "suitsChanged")).toEqual({
      type: "suitsChanged",
      suits: [],
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    suits.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("an agent's preview reaches the person's sockets only; keep and revert follow it there", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-suit-looks-")));
  const root = join(home, "suits");
  await mkdir(join(root, "sample-suit"), { recursive: true });
  await writeFile(
    join(root, "sample-suit", "suit.json"),
    JSON.stringify({ format: 1, id: "sample-suit", name: "Sample Suit", dark: {} }),
  );
  const suits = library(root);
  await suits.start();
  const looks = new SuitLooks(() => "keep-1");
  const thread = ThreadId.parse("thread-agent");
  // Only the person's own devices may read the agent's thread.
  const readers = new Set<string>();
  const sockets: WebSocket[] = [];
  try {
    const f = await setup({
      suits,
      suitLooks: looks,
      canReadThread: (device, id) => id !== thread || readers.has(device),
    });
    const laptop = await connect(f, sockets, ["read"]);
    readers.add(laptop.id);
    const stranger = await connect(f, sockets, ["read"]);
    // A reader that never asks: its replies are never preceded by a look it didn't request.
    const phone = await connect(f, sockets, ["read"]);
    readers.add(phone.id);
    expect(await phone.quiet("unasked")).toEqual([]);

    // Each socket that asks hears the state then: no preview yet.
    stranger.watch();
    expect(await stranger.active()).toEqual({ kind: "none" });
    laptop.watch();
    expect(await laptop.active()).toEqual({ kind: "none" });
    const previews = new SuitPreviews(
      daemonSuitPort(
        () => suits,
        () => looks,
      ),
    );
    const caller: McpAttribution = {
      sessionId: "session-1",
      threadId: thread,
      agentId: AgentId.parse("agent-1"),
    };
    const signal = new AbortController().signal;

    expect(await previews.preview(caller, "sample-suit", signal)).toMatchObject({
      status: "previewing",
    });
    expect(await laptop.active()).toEqual({ kind: "preview", suitId: "sample-suit" });

    expect(await previews.keep(caller, undefined, signal)).toMatchObject({ status: "kept" });
    expect(await laptop.active()).toEqual({
      kind: "keep",
      suitId: "sample-suit",
      keepId: "keep-1",
    });

    expect(await previews.revert(caller)).toMatchObject({ status: "reverted" });
    expect(await laptop.active()).toEqual({ kind: "restore", keepId: "keep-1" });
    expect(await stranger.quiet("after")).toEqual([]);
    // The phone may read the thread but never asked, so it heard none of it.
    expect(await phone.quiet("phone-after")).toEqual([]);

    // A turn's end takes its preview down on the devices that saw it.
    await previews.preview(caller, "sample-suit", signal);
    expect(await laptop.active()).toEqual({ kind: "preview", suitId: "sample-suit" });
    await previews.turnEnded(thread);
    expect(await laptop.active()).toEqual({ kind: "none" });
  } finally {
    for (const socket of sockets) socket.terminate();
    suits.close();
    await rm(home, { recursive: true, force: true });
  }
});
