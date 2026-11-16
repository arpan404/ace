import { expect, test } from "vitest";
import { stripAceOriginMarker } from "@ace/ui-core";
import { AgentId, ThreadId, type AccessMode, type McpAttribution } from "@ace/protocol";
import {
  messageRoute,
  peerText,
  type Edge,
  type PeerThread,
  type RoutePorts,
} from "./peer-messages.ts";

const id = (name: string) => ThreadId.parse(name);
const thread = (name: string, access: AccessMode | null = "full-access"): PeerThread => ({
  id: id(name),
  title: `${name} work`,
  permission: { override: null, effective: access, pending: false },
});
const caller = (name: string): McpAttribution => ({
  sessionId: "lease",
  threadId: id(name),
  agentId: AgentId.parse("agent"),
});

/** A small world of threads: who exists, who owns what, who reads what, who wrote to whom. */
function world(options: {
  threads: PeerThread[];
  edges?: Record<string, Edge & { parentId?: string }>;
  owns?: [string, string][];
  unreadable?: string[];
  messaged?: [string, string][];
}): RoutePorts {
  const threads = new Map(options.threads.map((entry) => [entry.id, entry]));
  const edges = options.edges ?? {};
  const ancestors = (child: string): string[] => {
    const parent = edges[child]?.parentId;
    return parent ? [parent, ...ancestors(parent)] : [];
  };
  return {
    thread: (target) => threads.get(target),
    edge: (target) => edges[target],
    owns: (from, target) =>
      ancestors(target).includes(from.threadId) ||
      (options.owns ?? []).some(([owner, owned]) => owner === from.threadId && owned === target),
    reads: (_from, target) => !(options.unreadable ?? []).includes(target),
    hasMessaged: (sender, receiver) =>
      (options.messaged ?? []).some(([from, to]) => from === sender && to === receiver),
    delegated: (ancestor, target) => ancestors(target).includes(ancestor),
  };
}

test("a thread's owners send as owners, whatever the thread", () => {
  const ports = world({
    threads: [thread("lead"), thread("child", "ask"), thread("started")],
    edges: { child: { phase: "settled", rootId: id("lead"), parentId: "lead" } },
    owns: [["lead", "started"]],
  });
  for (const target of ["child", "started", "lead"])
    expect(messageRoute(ports, caller("lead"), id(target))).toEqual({
      kind: "owner",
      threadId: id(target),
    });
});

test("another agent's running child hears a peer directly; a finished one's top-level thread hears instead", () => {
  const edges = (phase: Edge["phase"]) => ({
    child: { phase, rootId: id("lead"), parentId: "lead" },
  });
  const threads = [thread("lead"), thread("child", "auto-review"), thread("peer")];
  expect(
    messageRoute(world({ threads, edges: edges("running") }), caller("peer"), id("child")),
  ).toEqual({ kind: "peer", threadId: id("child"), requested: id("child") });
  for (const phase of ["settled", "created", "cancelling"] as const)
    expect(
      messageRoute(world({ threads, edges: edges(phase) }), caller("peer"), id("child")),
    ).toEqual({ kind: "peer", threadId: id("lead"), requested: id("child") });
});

test("a peer is refused a thread it can't read, or one with broader access, with why", () => {
  const unreadable = world({
    threads: [thread("peer"), thread("other")],
    unreadable: ["other"],
  });
  expect(messageRoute(unreadable, caller("peer"), id("other"))).toMatchObject({
    kind: "refused",
    hint: expect.stringContaining("threads_find"),
  });
  const broader = world({ threads: [thread("peer", "ask"), thread("other", "full-access")] });
  expect(messageRoute(broader, caller("peer"), id("other"))).toMatchObject({
    kind: "refused",
    hint: expect.stringContaining("broader access"),
  });
  // Unranked policies match only the same policy; full access reaches any of them.
  const unranked = world({ threads: [thread("peer", "ask"), thread("other", null)] });
  expect(messageRoute(unranked, caller("peer"), id("other")).kind).toBe("refused");
  const full = world({ threads: [thread("peer"), thread("other", null)] });
  expect(messageRoute(full, caller("peer"), id("other")).kind).toBe("peer");
});

test("a thread answers one that wrote to it, and a child writes to its parent, whatever their access", () => {
  const replying = world({
    threads: [thread("asker", "full-access"), thread("helper", "read-only")],
    unreadable: ["asker"],
    messaged: [["asker", "helper"]],
  });
  expect(messageRoute(replying, caller("helper"), id("asker"))).toEqual({
    kind: "peer",
    threadId: id("asker"),
    requested: id("asker"),
  });
  const child = world({
    threads: [thread("lead", "full-access"), thread("child", "read-only")],
    edges: { child: { phase: "running", rootId: id("lead"), parentId: "lead" } },
  });
  expect(messageRoute(child, caller("child"), id("lead")).kind).toBe("peer");
  // Writing first is what opens the way back, not having been written to.
  const unasked = world({
    threads: [thread("asker", "full-access"), thread("helper", "read-only")],
    messaged: [["helper", "asker"]],
  });
  expect(messageRoute(unasked, caller("helper"), id("asker")).kind).toBe("refused");
});

test("a peer's message names its sender to the agent and leaves only the words for the person", () => {
  const sender = { ...thread("net"), title: "Network [audit]\nphase 2" };
  const text = peerText(sender, { delegated: true }, "Use the relay's new port.");
  const [marker] = text.split("\n");
  expect(marker).toContain(`"Network audit phase 2" (net)`);
  expect(marker).toContain("not the person or your parent");
  expect(marker).toContain("agent_message with threadId net");
  // The transcript strips ace's marker: the person reads the message as sent.
  expect(stripAceOriginMarker(text)).toBe("Use the relay's new port.");
  const routed = peerText(sender, { delegated: false }, "Heads up", {
    thread: thread("child"),
    id: id("child"),
  });
  expect(routed.split("\n")[0]).toContain(`"child work" (child)`);
  expect(routed.split("\n")[0]).not.toContain("your parent");
  expect(stripAceOriginMarker(routed)).toBe("Heads up");
});
