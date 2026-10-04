import { expect, test } from "vitest";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { createCodexTranslator, codexCapabilities } from "@ace/adapter-codex";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { Command, DeviceId } from "@ace/protocol";
import { Client } from "../socket-test-support.ts";
import { until } from "./test-support.ts";

// Mutation 4: replace prepared nested fields with plain objects or discard payloads.
// Not executed (tests run at merge).
test("unknown provider frames survive the daemon's bounded redacted debug file sink", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-provider-diagnostics-"));
  const registry = new AdapterRegistry();
  registry.register(
    createScriptedAdapter({
      provider: "codex",
      capabilities: codexCapabilities({
        installed: true,
        auth: "logged_in",
        version: "0.159.1",
        loginHint: "unused",
      }),
      createTranslator: createCodexTranslator,
      steps: [
        {
          on: "send",
          frames: [
            {
              seq: 1,
              t: 1,
              dir: "recv",
              channel: "stdio",
              data: { method: "thread/started", params: { thread: { id: "native", cwd: home } } },
            },
            {
              seq: 2,
              t: 2,
              dir: "recv",
              channel: "stdio",
              data: {
                method: "future/evidence",
                params: {
                  threadId: "native",
                  detail: { message: "retained-evidence", api_key: "never-log-this" },
                  large: "x".repeat(10000),
                },
              },
            },
            {
              seq: 3,
              t: 3,
              dir: "recv",
              channel: "stdio",
              data: {
                method: "turn/started",
                params: { threadId: "native", turn: { id: "turn" } },
              },
            },
            {
              seq: 4,
              t: 4,
              dir: "recv",
              channel: "stdio",
              data: {
                method: "turn/completed",
                params: { threadId: "native", turn: { id: "turn", status: "completed" } },
              },
            },
          ],
        },
      ],
    }),
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "debug" }),
    modelInstances: [],
    engine: { registry },
  });
  const client = new Client(daemon.url);
  try {
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("device"),
      token: await readFile(daemon.tokenPath, "utf8"),
    });
    await until(client, (m) => m.type === "welcome");
    const done = Promise.withResolvers<void>();
    const unsubscribe = daemon.store.subscribe((events) => {
      if (
        events.some(
          (e) => e.payload.type === "thread.updated" && e.payload.status?.state === "done",
        )
      )
        done.resolve();
    });
    const workspaceId = daemon.store.createWorkspace(home, "Workspace");
    client.send({
      type: "command",
      command: Command.parse({
        id: "send",
        deviceId: "device",
        payload: {
          type: "thread.create",
          workspaceId,
          provider: "codex",
          input: [{ type: "text", text: "fixture input" }],
        },
      }),
    });
    expect(
      await until(client, (m) => m.type === "commandResult" && m.commandId === "send"),
    ).toMatchObject({ ok: true });
    await done.promise;
    unsubscribe();
    await client.close();
    await daemon.close();
    const logs = (await readFile(join(home, "logs", "ace.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.includes('"message":"Provider diagnostic"'))
      .join("\n");
    expect(logs).toContain("future/evidence");
    expect(logs).toContain("retained-evidence");
    expect(logs).not.toContain("never-log-this");
    expect(logs).not.toContain("x".repeat(10000));
    expect(logs).not.toContain("<UNPREPARED OBJECT OMITTED>");
  } finally {
    await client.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
