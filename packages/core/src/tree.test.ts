import { ThreadId, type Agent, type EventPayload } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { apply, createThreadState, type Fact, type ThreadState } from "./index.ts";
import { assertPayloads } from "./test-helper.ts";

function setup(configuredRoot = true) {
  let sequence = 0;
  let time = 100;
  const ids = { next: (kind: string) => `${kind}_${++sequence}` };
  const state = createThreadState({
    threadId: ThreadId.parse("thread"),
    config: { silenceMs: 90_000 },
    ...(configuredRoot
      ? {
          rootAgent: {
            agent: "root",
            fidelity: "full",
            native: { provider: "codex" },
            cwd: "/repo",
          } satisfies NonNullable<Parameters<typeof createThreadState>[0]["rootAgent"]>,
        }
      : {}),
  });
  const history: EventPayload[] = [];
  function send(fact: Fact, target = state, now = ++time): EventPayload[] {
    const events = apply(target, fact, { now, ids });
    assertPayloads(events);
    history.push(...events);
    return events;
  }
  if (configuredRoot) send({ type: "tick" }, state, 100);
  return { state, history, send };
}

function createdAgent(events: EventPayload[], nativeKey: string): Agent {
  const event = events.find(
    (payload) => payload.type === "agent.created" && payload.agent.native.nativeId === nativeKey,
  );
  if (!event || event.type !== "agent.created")
    throw new Error(`Missing agent.created for ${nativeKey}`);
  return event.agent;
}

function spawn(childAgent?: string): Extract<Fact, { type: "item.upsert" }> {
  return {
    type: "item.upsert",
    agent: "root",
    item: "spawn",
    draft: {
      type: "tool_call",
      complete: false,
      call: {
        kind: "agent.spawn",
        title: "Worker",
        status: "running",
        detail: { kind: "agent.spawn", ...(childAgent === undefined ? {} : { childAgent }) },
        raw: [],
      },
    },
  };
}

describe("agent tree facts", () => {
  it("uses the configured root identity for its first run and the injected creation time", () => {
    const h = setup();
    const root = createdAgent(h.history, "root");
    expect(root.createdAt).toBe(100);
    expect(h.history).toContainEqual({
      type: "agent.updated",
      agentId: root.id,
      fidelity: "full",
      native: { provider: "codex" },
      cwd: "/repo",
    });
    const events = h.send({ type: "turn.started", agent: "root", trigger: "user" });
    expect(events.filter((event) => event.type === "agent.created")).toEqual([]);
    expect(events.find((event) => event.type === "run.started")).toEqual({
      type: "run.started",
      run: {
        id: "run_2",
        threadId: "thread",
        agentId: root.id,
        trigger: "user",
        state: "active",
        startedAt: 101,
      },
    });
  });

  it("publishes the unknown parent and the completed metadata of its child", () => {
    const h = setup();
    const root = createdAgent(h.history, "root");
    const events = h.send({
      type: "agent.seen",
      agent: "grandchild",
      parent: "parent",
      origin: "provider_subagent",
      fidelity: "summary",
      native: { provider: "claude", nativeId: "task" },
      cwd: "/other",
      role: "explorer",
    });
    const parent = createdAgent(events, "parent");
    const child = createdAgent(events, "grandchild");
    expect(parent.parentId).toBe(root.id);
    expect(parent.fidelity).toBe("placeholder");
    expect(events).toContainEqual({
      type: "agent.updated",
      agentId: child.id,
      parentId: parent.id,
    });
    expect(events).toContainEqual({
      type: "agent.updated",
      agentId: child.id,
      fidelity: "summary",
      native: { provider: "claude", nativeId: "task" },
      cwd: "/other",
      role: "explorer",
    });
  });

  it("publishes the real root and reparents a child discovered first without replacing its id", () => {
    const h = setup(false);
    const first = h.send({ type: "turn.started", agent: "child", trigger: "spawn" });
    const child = createdAgent(first, "child");
    const linked = h.send({ type: "agent.linked", agent: "child", parent: "root" });
    const root = createdAgent(linked, "root");
    expect(linked).toContainEqual({ type: "agent.updated", agentId: root.id, parentId: null });
    expect(linked).toContainEqual({ type: "agent.updated", agentId: root.id, origin: "root" });
    expect(linked).toContainEqual({ type: "agent.updated", agentId: child.id, parentId: root.id });
    expect(linked).toContainEqual({
      type: "agent.updated",
      agentId: child.id,
      origin: "provider_subagent",
    });
    const completed = h.send({ type: "turn.ended", agent: "child", outcome: "completed" });
    expect(completed).toContainEqual({
      type: "agent.status",
      agentId: child.id,
      status: { state: "idle" },
    });
  });

  it("joins a child to a spawning item that arrives later and does not duplicate the link", () => {
    const h = setup();
    const childEvents = h.send({
      type: "agent.linked",
      agent: "child",
      parent: "root",
      spawnedBy: "spawn",
    });
    const child = createdAgent(childEvents, "child");
    expect(childEvents.filter((event) => event.type === "agent.updated")).toEqual([]);
    const events = h.send(spawn());
    const itemCreated = events.find((event) => event.type === "item.created");
    if (!itemCreated || itemCreated.type !== "item.created")
      throw new Error("Missing spawning item");
    expect(events).toContainEqual({
      type: "agent.updated",
      agentId: child.id,
      spawnedBy: itemCreated.item.id,
    });
    const itemUpdated = events.find((event) => event.type === "item.updated");
    expect(itemUpdated?.type === "item.updated" && itemUpdated.item).toEqual({
      ...itemCreated.item,
      call: {
        id: itemCreated.item.id,
        agentId: createdAgent(h.history, "root").id,
        kind: "agent.spawn",
        title: "Worker",
        status: "running",
        detail: { kind: "agent.spawn", childAgentId: child.id },
        startedAt: 102,
        raw: [],
      },
    });
    expect(
      h.send({ type: "agent.linked", agent: "child", parent: "root", spawnedBy: "spawn" }),
    ).toEqual([]);
  });

  it("assigns a child identity when the spawning call is its first sighting", () => {
    const h = setup();
    const events = h.send(spawn("child"));
    const child = createdAgent(events, "child");
    const item = events.find((event) => event.type === "item.created");
    if (!item || item.type !== "item.created" || item.item.type !== "tool_call") {
      throw new Error("Missing spawning call");
    }
    expect(item.item.call.detail).toEqual({ kind: "agent.spawn", childAgentId: child.id });
    expect(events).toContainEqual({
      type: "agent.updated",
      agentId: child.id,
      spawnedBy: item.item.id,
    });
    const revealed = h.send({
      type: "agent.seen",
      agent: "child",
      parent: "root",
      origin: "provider_subagent",
      fidelity: "full",
      native: { provider: "codex", nativeId: "native-child" },
      cwd: "/repo",
    });
    expect(revealed.filter((event) => event.type === "agent.created")).toEqual([]);
    expect(revealed).toContainEqual({
      type: "agent.updated",
      agentId: child.id,
      fidelity: "full",
      native: { provider: "codex", nativeId: "native-child" },
    });
  });

  it("starts and closes agents with prototype-like keys after restoring a snapshot", () => {
    const h = setup();
    const restored: ThreadState = JSON.parse(JSON.stringify(h.state));
    for (const key of ["__proto__", "constructor"]) {
      const events = h.send({ type: "turn.started", agent: key, trigger: "spawn" }, restored);
      const child = createdAgent(events, key);
      expect(child.parentId).toBe(createdAgent(h.history, "root").id);
      expect(
        h.send({ type: "turn.ended", agent: key, outcome: "completed" }, restored),
      ).toContainEqual({ type: "agent.status", agentId: child.id, status: { state: "idle" } });
    }
  });

  it("rejects a cyclic parent fact and preserves the previously published relationship", () => {
    const h = setup();
    h.send({ type: "agent.linked", agent: "parent", parent: "root" });
    h.send({ type: "agent.linked", agent: "child", parent: "parent" });
    expect(() => h.send({ type: "agent.linked", agent: "parent", parent: "child" })).toThrow(
      "cycle",
    );
    // Rejected facts have no public payload; inspect the canonical row they would have changed.
    expect(h.state.agents.parent?.agent.parentId).toBe(createdAgent(h.history, "root").id);
  });

  it("replays emitted late tree updates to the same canonical agents as the snapshot", () => {
    const h = setup();
    h.send({ type: "turn.started", agent: "child", trigger: "spawn" });
    h.send({ type: "agent.linked", agent: "parent", parent: "root" });
    h.send({
      type: "agent.seen",
      agent: "child",
      parent: "parent",
      spawnedBy: "parent-spawn",
      origin: "provider_subagent",
      fidelity: "full",
      cwd: "/child",
      native: { provider: "codex", nativeId: "native-child", aliases: ["other-child"] },
      name: "Worker",
      role: "explorer",
      model: "coding-model",
      background: true,
    });
    h.send({ ...spawn(), agent: "parent", item: "parent-spawn" });
    const replayed = new Map<string, Agent>();
    for (const event of h.history) {
      if (event.type === "agent.created")
        replayed.set(event.agent.id, structuredClone(event.agent));
      else if (event.type === "agent.updated") {
        const { type: _type, agentId, ...fields } = event;
        Object.assign(replayed.get(agentId)!, fields);
      } else if (event.type === "agent.status") {
        replayed.get(event.agentId)!.status = structuredClone(event.status);
      }
    }
    // This full row comparison verifies a client can recover every field from replay.
    for (const record of Object.values(h.state.agents))
      expect(replayed.get(record.agent.id)).toEqual(record.agent);
    expect(createdAgent(h.history, "child").fidelity).toBe("placeholder");
  });
});
