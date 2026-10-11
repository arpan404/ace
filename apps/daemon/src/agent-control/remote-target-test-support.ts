import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, expect } from "vitest";
import {
  DeviceId,
  RemoteAgentHost,
  RemoteTask,
  type ClientMessage,
  type RemoteDelegationResult,
} from "@ace/protocol";
import { Client } from "../socket-test-support.ts";
import { RemoteDelegations } from "./remote.ts";
import { setup } from "./test-support.ts";
import { daemonFixture } from "./daemon-test-support.ts";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

export async function remoteTarget(policy: { maxChildren?: number; maxDepth?: number } = {}) {
  const source = setup(policy);
  const parent = await source.parent();
  const target = await daemonFixture();
  cleanup.push(() => target.daemon.close());
  const wire = new Client(target.daemon.url);
  cleanup.push(() => wire.close());
  await once(wire.socket, "open");
  wire.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("broker"),
    token: await readFile(target.daemon.tokenPath, "utf8"),
  });
  const welcome = await wire.next();
  if (welcome.type !== "welcome") throw new Error("No welcome");
  const remote = new RemoteDelegations({
    store: source.store,
    engine: source.engine,
    local: source.service,
    hostId: "source",
    now: source.clock.now,
    id: randomUUID,
    admit: () => true,
  });
  cleanup.push(() => remote.close());
  const lease = remote.register(
    "broker",
    [
      RemoteAgentHost.parse({
        hostId: welcome.hostId,
        name: "Target",
        projects: [{ workspaceId: target.workspace, name: "Project" }],
        agents: [
          {
            provider: "claude",
            model: "chosen-model",
            permissionModes: [{ id: "plan", label: "Safe", description: "safe", risk: "low" }],
          },
        ],
      }),
    ],
    () => true,
  );
  if (!lease) throw new Error("No broker lease");
  const result = await remote.execute(
    parent,
    {
      op: "device.delegate",
      requestId: "work",
      hostId: welcome.hostId,
      workspaceId: target.workspace,
      provider: "claude",
      model: "chosen-model",
      task: "Review",
      role: "Reviewer",
      mode: "local",
    },
    new AbortController().signal,
  );
  expect(result.ok).toBe(true);
  const task = RemoteTask.parse(result.data);
  remote.poll("broker", lease);
  async function request(
    message: Extract<
      ClientMessage,
      { type: "delegation.remote.start" | "delegation.remote.status" | "delegation.remote.cancel" }
    >,
  ): Promise<RemoteDelegationResult> {
    wire.send(message);
    for (;;) {
      const response = await wire.next();
      if (response.type === "delegation.broker.result" && response.requestId === message.requestId)
        return response;
    }
  }
  const admission = await request({ type: "delegation.remote.start", requestId: "start", task });
  expect(admission, JSON.stringify(admission)).toMatchObject({ ok: true });
  await target.daemon.engine?.flush();
  const root = target.daemon.store.getThread(task.threadId);
  if (!root?.rootAgentId) throw new Error("Missing target root");
  const caller = { sessionId: "test", threadId: root.id, agentId: root.rootAgentId };
  async function emit(...facts: import("@ace/core").Fact[]) {
    const session = target.h.contexts.get(task.threadId);
    if (!session) throw new Error("Missing target session");
    session.onFrame(target.h.frames.frame(...facts));
    await target.daemon.engine?.flush();
  }
  async function complete(text: string) {
    await emit(
      {
        type: "item.upsert",
        agent: "root",
        item: randomUUID(),
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text }],
          complete: true,
        },
      },
      { type: "turn.ended", agent: "root", outcome: "completed" },
    );
  }
  return {
    source,
    parent,
    remote,
    target,
    task,
    caller,
    request,
    emit,
    complete,
    hostId: welcome.hostId,
  };
}
