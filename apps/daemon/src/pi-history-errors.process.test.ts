import { expect, test } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { startDaemon, readConfig } from "@ace/daemon";
import { Command, DeviceId } from "@ace/protocol";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { readJsonLines } from "@ace/provider-kit/jsonl";
import { Client } from "./socket-test-support.ts";
import { until } from "./engine/test-support.ts";

test("Pi history cancellation returns a bounded specific diagnostic through the daemon socket", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-pi-diagnostic-"));
  await writeFile(
    join(home, "source.jsonl"),
    JSON.stringify({ type: "session", version: 3, id: "native", cwd: home }) + "\n",
  );
  const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
  const absent = { installed: false, auth: "unknown" as const, loginHint: "unused" };
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    engine: {
      adapterDiscovery: async () => ({
        claude: absent,
        codex: absent,
        opencode: absent,
        cursor: absent,
      }),
    },
    pi: {
      runtime: {
        discover: async () => ({
          installed: true,
          path: "/synthetic/pi",
          version: "0.85.1",
          auth: "unknown",
          loginHint: "unused",
        }),
        spawn(options) {
          const proc = spawnTextSupervised({
            ...options,
            command: process.execPath,
            env: { ...options.env, FAKE_PI_HOME: home, FAKE_PI_CANCEL_ROLLBACK: "1" },
            args: [
              fileURLToPath(
                new URL("../../../packages/adapter-pi/src/testing/fake-pi.ts", import.meta.url),
              ),
              ...(options.args ?? []),
            ],
          });
          const detach = readJsonLines(
            proc.stdout,
            1024 * 1024,
            (line) => {
              const event = z.looseObject({ type: z.string() }).parse(JSON.parse(line));
              if (event.type === "agent_settled") settle();
            },
            () => {},
          );
          void proc.exited.then(detach);
          return proc;
        },
      },
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
    const workspaceId = daemon.store.createWorkspace(home, "Pi fixture");
    client.send({
      type: "command",
      command: Command.parse({
        id: "create",
        deviceId: "device",
        payload: {
          type: "thread.create",
          workspaceId,
          provider: "pi",
          input: [{ type: "text", text: "synthetic" }],
        },
      }),
    });
    expect(await until(client, (message) => message.type === "commandResult")).toMatchObject({
      ok: true,
    });
    await settled;
    await daemon.engine?.flush();
    const thread = daemon.store.listThreads()[0];
    if (!thread) throw new Error("Missing Pi thread");
    expect(thread.status.state).toBe("done");
    client.send({
      type: "pi.control",
      requestId: "rollback",
      threadId: thread.id,
      operation: { kind: "rollback", entryId: "entry" },
    });
    expect(await until(client, (message) => message.type === "pi.result")).toMatchObject({
      result: { ok: false, error: "Pi navigation was not acknowledged" },
    });
  } finally {
    await client.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
