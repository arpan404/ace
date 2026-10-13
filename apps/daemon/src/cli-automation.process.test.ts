import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Automation, DeviceId, ThreadId, type ClientMessage } from "@ace/protocol";
import { z } from "zod";
import { Client } from "./socket-test-support.ts";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { invoke } from "./cli-test-support.ts";

test("automation CLI retries one shared run and keeps it running across descendant work and held input", async () => {
  const f = await daemonFixture();
  const home = join(f.h.home, "daemon");
  const client = new Client(f.daemon.url);
  try {
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("automation-test"),
      token: await readFile(join(home, "daemon-token"), "utf8"),
    });
    expect((await client.next()).type).toBe("welcome");
    const ask = async (message: ClientMessage) => {
      client.send(message);
      for (;;) {
        const reply = await client.next();
        if (reply.type === "automation.result") return reply;
      }
    };
    await f.daemon.settings.set("automations.enabled", true, { kind: "global" });
    const automation = Automation.parse({
      id: "cli-shared-run",
      title: "CLI automation",
      enabled: true,
      workspace: f.workspace,
      provider: "claude",
      prompt: "Review {{branch}}",
      worktree: false,
      trigger: { kind: "manual" },
      missedRun: "skip",
      concurrency: 1,
      jitterMs: 0,
    });
    expect((await ask({ type: "automation.put", requestId: "put", automation })).ok).toBe(true);
    const listed = await invoke(home, ["automation", "list", "--json"]);
    expect(JSON.parse(listed.stdout).automations).toContainEqual(automation);
    const args = [
      "automation",
      "run",
      automation.id,
      "--variables",
      '{"branch":"main"}',
      "--idempotency-key",
      "run-once",
      "--json",
    ];
    const first = await invoke(home, args);
    expect(first.code, first.stderr).toBe(0);
    const schema = z.object({ run: z.object({ id: z.string() }), idempotencyKey: z.string() });
    const run = schema.parse(JSON.parse(first.stdout)).run;
    const retry = await invoke(home, args);
    expect(schema.parse(JSON.parse(retry.stdout)).run.id).toBe(run.id);
    const inbox = async () =>
      (await ask({ type: "automation.inbox", requestId: "inbox", limit: 100 })).inbox?.runs.find(
        (entry) => entry.id === run.id,
      );
    // A run reports its thread only when it settles, so find the thread it admitted.
    const admitted = () =>
      f.daemon.store.listThreads().find((thread) => thread.title === "Automation: CLI automation")
        ?.id;
    await expect.poll(admitted).toBeDefined();
    const parent = ThreadId.parse(admitted());
    const spawn = await invoke(home, [
      "task",
      "spawn",
      "Descendant",
      "--parent",
      parent,
      "--provider",
      "claude",
      "--json",
    ]);
    const child = z
      .object({ data: z.object({ threadId: ThreadId }) })
      .parse(JSON.parse(spawn.stdout)).data.threadId;
    await f.daemon.engine?.flush();
    await f.h.complete(parent, "Root answer");
    f.h.clock.advance(f.h.clock.now() + 1000);
    expect((await inbox())?.status).toBe("running");
    expect(f.daemon.store.getThread(child)?.status.state).toBe("working");
    await invoke(home, ["thread", "interrupt", parent, "--json"]);
    f.h.clock.advance(f.h.clock.now() + 1000);
    expect((await inbox())?.status).toBe("running");
    await invoke(home, ["kill-all", "--thread", parent, "--json"]);
    f.h.clock.advance(f.h.clock.now() + 1000);
    await expect.poll(async () => (await inbox())?.status).toBe("failed");
  } finally {
    await client.close();
    await f.daemon.close();
  }
});
