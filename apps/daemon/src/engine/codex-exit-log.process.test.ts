import { expect, test } from "vitest";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "@ace/adapter-codex";
import { AdapterRegistry, readConfig, startDaemon } from "@ace/daemon";
import { Command, DeviceId } from "@ace/protocol";
import { Client } from "../socket-test-support.ts";
import { until } from "./test-support.ts";

// Not executed (tests run at merge). Real daemon/log sink with an offline native boundary.
test("Codex exit evidence reaches the daemon debug log with code, signal and redacted stderr", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-codex-exit-log-"));
  const binary = join(home, "offline-codex.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}\nimport ${JSON.stringify(new URL("../../../../packages/adapter-codex/src/testing/cli.ts", import.meta.url).href)};\n`,
  );
  await chmod(binary, 0o755);
  const registry = new AdapterRegistry();
  registry.register(
    createCodexAdapter({
      cli: {
        installed: true,
        path: binary,
        version: "0.159.1",
        auth: "logged_in",
        loginHint: "unused",
      },
    }),
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "debug" }),
    modelInstances: [],
    engine: {
      registry,
      sessionContext: async () => ({ env: { ACE_FAKE_RESUME: "exit-diagnostic" } }),
    },
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
    await until(client, (message) => message.type === "welcome");
    const ended = Promise.withResolvers<void>();
    const stop = daemon.store.subscribe((events) => {
      if (
        events.some(
          (event) => event.payload.type === "run.ended" && event.payload.state === "failed",
        )
      )
        ended.resolve();
    });
    const workspaceId = daemon.store.createWorkspace(home, "Workspace");
    client.send({
      type: "command",
      command: Command.parse({
        id: "exit",
        deviceId: "device",
        payload: {
          type: "thread.create",
          workspaceId,
          provider: "codex",
          input: [{ type: "text", text: "exit" }],
        },
      }),
    });
    expect(
      await until(
        client,
        (message) => message.type === "commandResult" && message.commandId === "exit",
      ),
    ).toMatchObject({ ok: true });
    await ended.promise;
    stop();
    await client.close();
    await daemon.close();
    const logs = await readFile(join(home, "logs", "ace.jsonl"), "utf8");
    expect(logs).toContain("codex-session-exit");
    expect(logs).toContain("offline app-server failure");
    expect(logs).toContain('\\"code\\":7');
    expect(logs).toContain('\\"signal\\":null');
    expect(logs).not.toContain("super-secret-test-token");
  } finally {
    await client.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
