import {
  Capabilities,
  Item,
  ServerMessage,
  Thread,
  ThreadId,
  ThreadListEntry,
} from "@ace/protocol";
import { describe, expect, it, vi } from "vitest";
import { createThreadListView, createThreadView } from "./index.ts";
import { supportedWireTrims, WireRestorer, WireTrimmer } from "./wire-trim.ts";

const capabilities = (steer: boolean) =>
  Capabilities.parse({
    steer,
    interruptCascades: true,
    resume: true,
    fork: true,
    subagentTranscripts: true,
    backgroundTaskControl: true,
    backgroundVisibility: "full",
    planMode: true,
    tokenUsage: true,
    imageInput: true,
    rewindFiles: false,
    launchOptions: ["effort", "serviceTier"],
  });
const thread = (id: string, caps: Capabilities | undefined) =>
  Thread.parse({
    id,
    workspaceId: "w",
    title: id,
    provider: "codex",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
    ...(caps ? { capabilities: caps } : {}),
  });
const message = (id: string, complete: boolean) =>
  Item.parse({
    id,
    agentId: "a",
    type: "message",
    role: "assistant",
    complete,
    createdAt: 1,
    parts: [{ type: "text", text: id }],
  });

/** What the socket carries: each frame as JSON text, read back by the full wire schema. */
const overTheWire = (frames: readonly unknown[]) =>
  frames.map((frame) => ServerMessage.parse(JSON.parse(JSON.stringify(frame))));
const bytes = (frames: readonly unknown[]) =>
  frames.reduce<number>((n, f) => n + JSON.stringify(f).length, 0);
const everyTrim = [...supportedWireTrims];

function threadSnapshot(caps: Capabilities | undefined) {
  const view = createThreadView(thread("t", caps), 4);
  view.items = { m1: message("m1", true), m2: message("m2", false) };
  view.itemOrder = ["m1", "m2"];
  view.itemSeqs = { m1: 1, m2: 2 };
  return { type: "snapshot" as const, subscriptionId: "s", seq: 4, view };
}

describe("wire trims", () => {
  it("restores independent capabilities on native runtimes without structuredClone", () => {
    const original = threadSnapshot(capabilities(true));
    const sent = overTheWire(new WireTrimmer(everyTrim).outgoing(original));
    const restorer = new WireRestorer();
    vi.stubGlobal("structuredClone", undefined);
    try {
      const received = sent
        .map((frame) => restorer.restore(frame))
        .filter((frame) => frame !== undefined);
      expect(received).toEqual(overTheWire([original]));
      const snapshot = received[0];
      if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "thread")
        throw new Error("shape");
      const launchOptions = snapshot.view.thread.capabilities?.launchOptions;
      if (!launchOptions) throw new Error("missing launch options");
      launchOptions.push("serviceTier");
      const again = overTheWire(new WireTrimmer(everyTrim).outgoing(original));
      const next = again[1];
      if (!next) throw new Error("missing snapshot");
      expect(restorer.restore(next)).toEqual(overTheWire([original])[0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("gives a client that asked for every trim the same thread snapshot in fewer bytes", () => {
    const original = threadSnapshot(capabilities(true));
    const sent = new WireTrimmer(everyTrim).outgoing(original);
    const restorer = new WireRestorer();
    const received = overTheWire(sent)
      .map((frame) => restorer.restore(frame))
      .filter((frame) => frame !== undefined);
    expect(received).toEqual(overTheWire([original]));
    expect(bytes(sent)).toBeLessThan(bytes([original]));
  });

  it("keeps an item that is still streaming marked incomplete", () => {
    const sent = new WireTrimmer(everyTrim).outgoing(threadSnapshot(undefined));
    const [snapshot] = overTheWire(sent);
    if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "thread") throw new Error("shape");
    expect(snapshot.view.items.m1).toMatchObject({ complete: true, synthetic: false, raw: [] });
    expect(snapshot.view.items.m2).toMatchObject({ complete: false });
  });

  it("trims the items of a history page", () => {
    const page = {
      type: "items.page" as const,
      requestId: "r",
      seq: 2,
      threadId: ThreadId.parse("t"),
      items: [message("m1", true)],
      itemSeqs: { m1: 1 },
      itemsBefore: null,
    };
    const sent = new WireTrimmer([...supportedWireTrims]).outgoing(page);
    expect(JSON.stringify(sent)).not.toContain('"complete"');
    expect(overTheWire(sent)).toEqual(overTheWire([page]));
  });

  it("sends a client that asked for nothing exactly what the daemon built", () => {
    const original = threadSnapshot(capabilities(true));
    expect(new WireTrimmer(undefined).outgoing(original)).toEqual([original]);
    expect(new WireTrimmer(["unknown-trim"]).outgoing(original)).toEqual([original]);
  });

  it("sends each provider's capabilities once, however many threads and patches use them", () => {
    const first = capabilities(true);
    const other = capabilities(false);
    const trimmer = new WireTrimmer(everyTrim);
    const list = createThreadListView(
      [thread("a", first), thread("b", structuredClone(first)), thread("c", other)],
      1,
    );
    const sent = trimmer.outgoing({ type: "snapshot", subscriptionId: "s", seq: 1, view: list });
    expect(sent.map((frame) => frame.type)).toEqual([
      "provider.capabilities",
      "provider.capabilities",
      "snapshot",
    ]);
    const patch = {
      type: "threads.patch" as const,
      subscriptionId: "s",
      seq: 2,
      threads: { a: ThreadListEntry.parse(thread("a", first)) },
      removed: [],
      window: { before: null, total: 3, counts: [] },
    };
    expect(trimmer.outgoing(patch).map((frame) => frame.type)).toEqual(["threads.patch"]);

    const restorer = new WireRestorer();
    const restored = overTheWire([...sent, ...trimmer.outgoing(patch)])
      .map((frame) => restorer.restore(frame))
      .filter((frame) => frame !== undefined);
    const [snapshot, afterPatch] = restored;
    if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "threads") throw new Error("shape");
    expect(snapshot.view.threads.a?.capabilities).toEqual(first);
    expect(snapshot.view.threads.b?.capabilities).toEqual(first);
    expect(snapshot.view.threads.c?.capabilities).toEqual(other);
    if (afterPatch?.type !== "threads.patch") throw new Error("shape");
    expect(afterPatch.threads.a?.capabilities).toEqual(first);
  });

  it("leaves a thread without capabilities when its key was never taught, rather than failing", () => {
    const sent = new WireTrimmer(everyTrim).outgoing(threadSnapshot(capabilities(true)));
    const [, snapshot] = overTheWire(sent);
    if (!snapshot) throw new Error("missing snapshot");
    const restored = new WireRestorer().restore(snapshot);
    if (restored?.type !== "snapshot" || restored.view.kind !== "thread") throw new Error("shape");
    expect(restored.view.thread.capabilities).toBeUndefined();
    expect(restored.view.thread.capabilitiesRef).toBeUndefined();
  });

  it("does not mutate the message the daemon shares with other connections", () => {
    const original = threadSnapshot(capabilities(true));
    const before = structuredClone(original);
    new WireTrimmer(everyTrim).outgoing(original);
    expect(original).toEqual(before);
  });
});
