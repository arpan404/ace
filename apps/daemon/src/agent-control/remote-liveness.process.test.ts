import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { expect, test } from "vitest";
import { Client, webSocketTransport } from "@ace/client";
import { DeviceId, RemoteAgentHost, RemoteAgentOperation, RemoteTask } from "@ace/protocol";
import { daemonFixture } from "./daemon-test-support.ts";

test("source liveness confirms reconciliation expiry before warnings are pruned and confirms maintenance removal", async () => {
  const f = await daemonFixture();
  const client = new Client({
    deviceId: DeviceId.parse("liveness-broker"),
    transport: () => webSocketTransport(() => new WebSocket(f.daemon.url)),
    credential: () => readFile(f.daemon.tokenPath, "utf8"),
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: () => () => {} },
    id: randomUUID,
    random: () => 0.5,
  });
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
  try {
    await client.start();
    await expect.poll(() => client.state).toBe("ready");
    const register = async () => {
      const reply = await client.request({ type: "delegation.broker.register", hosts: [host] });
      if (!reply.lease) throw new Error("Missing lease");
      return reply.lease;
    };
    let lease = await register();
    const result = await f.controls.remote.execute(
      f.caller,
      RemoteAgentOperation.parse({
        op: "device.delegate",
        requestId: "retained-warning",
        hostId: "target",
        workspaceId: "project",
        provider: "codex",
        model: "chosen-model",
        role: "Reviewer",
        task: "Review",
        mode: "local",
      }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    const incoming = RemoteTask.parse(result.data);
    const missing = "f".repeat(64);
    const poll = () =>
      client.request({
        type: "delegation.broker.poll",
        lease,
        trackedTaskIds: [incoming.id, missing],
      });
    expect((await poll()).inactiveTaskIds).toEqual([missing]);
    f.controls.remote.stopTask(incoming.id);
    f.h.clock.advance(f.h.clock.now() + 30_000);
    lease = await register();
    expect((await poll()).inactiveTaskIds).toEqual([missing]);
    const status = () =>
      f.controls.remote.execute(
        f.caller,
        { op: "device.task_status", taskId: incoming.id },
        new AbortController().signal,
      );
    expect(await status()).toMatchObject({ ok: true, data: { phase: "failed" } });
    await f.daemon.engine?.flush();
    const session = f.h.contexts.get(f.caller.threadId);
    if (!session) throw new Error("Missing parent provider session");
    session.onFrame(f.h.frames.frame({ type: "turn.started", agent: "root", trigger: "user" }));
    await f.daemon.engine?.flush();

    f.h.clock.advance(f.h.clock.now() + 7 * 24 * 60 * 60 * 1000 + 1);
    lease = await register();
    const expired = await poll();
    expect(expired.inactiveTaskIds).toEqual([incoming.id, missing]);
    expect(expired.tasks).toEqual([]);
    // The working parent still retains the durable warning. Eligibility expiry
    // is authoritative even before maintenance can physically delete the row.
    expect(await status()).toMatchObject({ ok: true, data: { phase: "failed" } });

    session.onFrame(f.h.frames.frame({ type: "turn.ended", agent: "root", outcome: "completed" }));
    await f.daemon.engine?.flush();
    f.controls.remote.journal.prune(f.h.clock.now());
    expect(await status()).toMatchObject({ ok: false, code: "not_found" });
    expect((await poll()).inactiveTaskIds).toEqual([incoming.id, missing]);
    expect(
      await client.request({
        type: "delegation.broker.poll",
        lease: "wrong",
        trackedTaskIds: [missing],
      }),
    ).toMatchObject({ ok: false, error: "forbidden" });
  } finally {
    await client.close();
    await f.daemon.close();
  }
});
