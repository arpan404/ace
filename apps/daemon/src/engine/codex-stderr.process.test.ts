import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createScriptedAdapter } from "@ace/adapter-testkit";
import { createCodexAdapter } from "@ace/adapter-codex";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { Command, DeviceId } from "@ace/protocol";
import { Client } from "../socket-test-support.ts";
import { until } from "./test-support.ts";

test("Codex fallback stderr goes to ordinary redacted logs while the answer stays readable", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-stderr-"));
  const codex = createCodexAdapter();
  const registry = new AdapterRegistry();
  const line =
    "\u001b[31mERROR\u001b[0m websocket: HTTP error: 403 Forbidden api_key=synthetic-secret";
  registry.register(
    createScriptedAdapter({
      provider: "codex",
      capabilities: codex.capabilities({
        installed: true,
        auth: "logged_in",
        version: "0.159.1",
        loginHint: "unused",
      }),
      createTranslator: (init) => codex.createTranslator(init),
      steps: [
        {
          on: "send",
          frames: [
            {
              seq: 0,
              t: 0,
              dir: "recv",
              channel: "stdio",
              data: { method: "thread/started", params: { thread: { id: "native", cwd: home } } },
            },
            {
              seq: 1,
              t: 1,
              dir: "recv",
              channel: "stdio",
              data: {
                method: "turn/started",
                params: { threadId: "native", turn: { id: "turn" } },
              },
            },
            ...Array.from({ length: 10 }, (_, i) => ({
              seq: i + 2,
              t: i + 2,
              dir: "stderr" as const,
              channel: "stderr",
              data: line,
            })),
            {
              seq: 12,
              t: 12,
              dir: "recv",
              channel: "stdio",
              data: {
                method: "item/completed",
                params: {
                  threadId: "native",
                  turnId: "turn",
                  item: {
                    id: "answer",
                    type: "agentMessage",
                    text: "QA_DONE",
                    phase: "final_answer",
                  },
                },
              },
            },
            {
              seq: 13,
              t: 13,
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
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "info" }),
    modelInstances: [],
    engine: { registry },
  });
  const client = new Client(daemon.url);
  const answered = Promise.withResolvers<void>();
  const unsubscribe = daemon.store.subscribe((events) => {
    if (
      events.some(
        (event) =>
          event.payload.type === "item.created" &&
          event.payload.item.type === "message" &&
          event.payload.item.role === "assistant" &&
          event.payload.item.parts.some((part) => part.type === "text" && part.text === "QA_DONE"),
      )
    )
      answered.resolve();
  });
  try {
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("device"),
      token: await readFile(daemon.tokenPath, "utf8"),
    });
    await until(client, (m) => m.type === "welcome");
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
          input: [{ type: "text", text: "Reply QA_DONE" }],
        },
      }),
    });
    const receipt = await until(
      client,
      (m) => m.type === "commandResult" && m.commandId === "send",
    );
    if (receipt.type !== "commandResult" || !receipt.threadId) throw new Error("No thread");
    await answered.promise;
    if (!daemon.engine) throw new Error("Missing daemon engine");
    await daemon.engine.flush();
    const view = daemon.store.snapshotThread(receipt.threadId);
    expect(
      Object.values(view.items).some(
        (item) =>
          item.type === "message" &&
          item.role === "assistant" &&
          item.parts.some((part) => part.type === "text" && part.text === "QA_DONE"),
      ),
    ).toBe(true);
    expect(Object.values(view.items).filter((item) => item.type === "notice")).toEqual([]);
    await client.close();
    await daemon.close();
    const logs = await readFile(join(home, "logs", "ace.jsonl"), "utf8");
    expect(logs).toContain("403 Forbidden");
    expect(logs).not.toContain("synthetic-secret");
  } finally {
    unsubscribe();
    await client.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
