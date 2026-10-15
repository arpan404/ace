import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { expect, test } from "vitest";
import { Client, webSocketTransport } from "@ace/client";
import {
  DeviceId,
  RemoteAgentHost,
  RemoteAgentOperation,
  RemoteTask,
  maxMessageBytes,
} from "@ace/protocol";
import { daemonFixture } from "./daemon-test-support.ts";

test("a broker reaches every message-sized remote task over polls that each fit one reply", async () => {
  const f = await daemonFixture();
  const client = new Client({
    deviceId: DeviceId.parse("large-task-broker"),
    transport: () => webSocketTransport(() => new WebSocket(f.daemon.url)),
    credential: () => readFile(f.daemon.tokenPath, "utf8"),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(ms, fn) {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    id: randomUUID,
    random: () => 0.5,
  });
  try {
    await client.start();
    await expect.poll(() => client.state).toBe("ready");
    const host = RemoteAgentHost.parse({
      hostId: "target",
      name: "Target",
      projects: [{ workspaceId: "project", name: "Project" }],
      agents: [
        {
          provider: "codex",
          model: "chosen-model",
          accessModes: ["read-only", "ask", "auto-review", "full-access"],
        },
      ],
    });
    const registration = await client.request({
      type: "delegation.broker.register",
      hosts: [host],
    });
    if (!registration.lease) throw new Error("Missing lease");
    const expected = new Map<string, string>();
    // Nine tasks at the message limit are more than one reply frame can carry together.
    for (let parent = 0; parent < 3; parent++) {
      const created = f.controls.delegations.command(`parent-${parent}`, {
        type: "thread.create",
        workspaceId: f.workspace,
        provider: "codex",
        input: [{ type: "text", text: "Plan" }],
      });
      await f.daemon.engine?.flush();
      const thread = created.threadId && f.daemon.store.getThread(created.threadId);
      if (!thread?.rootAgentId) throw new Error("Missing parent");
      for (let child = 0; child < 3; child++) {
        const text = `${parent}${child}`.repeat(maxMessageBytes / 2);
        const result = await f.controls.remote.execute(
          { ...f.caller, threadId: thread.id, agentId: thread.rootAgentId },
          RemoteAgentOperation.parse({
            op: "device.delegate",
            requestId: `large-${child}`,
            hostId: "target",
            workspaceId: "project",
            provider: "codex",
            model: "chosen-model",
            role: "Reviewer",
            task: text,
          }),
          new AbortController().signal,
        );
        expect(result.ok).toBe(true);
        const task = RemoteTask.parse(result.data);
        // The agent reads its own long task back clipped rather than whole.
        expect(task.request.task.length).toBeLessThan(text.length);
        expected.set(task.id, text);
      }
    }
    const seen = new Map<string, string>();
    for (let poll = 0; poll < 4; poll++) {
      const reply = await client.request({
        type: "delegation.broker.poll",
        lease: registration.lease,
      });
      expect(reply.ok).toBe(true);
      expect(reply.tasks?.length).toBeGreaterThan(0);
      for (const task of reply.tasks ?? []) seen.set(task.id, task.request.task);
    }
    expect(seen).toEqual(expected);
    expect(client.state).toBe("ready");
  } finally {
    client.close();
    await f.daemon.close();
  }
});
