import { spawnGitProcess as spawn } from "@ace/git";
import { CommandId, DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { projectFixture, projectServer, until } from "./projects-test-support.ts";

test("a clone started on a socket can be cancelled on that socket while it runs", async () => {
  const f = await projectFixture({
    git: {
      timeoutMs: 15_000,
      processRuntime: {
        // A clone that reports progress, then stalls until it is killed.
        spawn(command, args, options) {
          if (!args.includes("clone")) return spawn(command, args, options);
          return spawn(
            process.execPath,
            [
              "-e",
              'require("node:fs").closeSync(3); process.stderr.write("Receiving objects: 1%\\r"); setInterval(() => {}, 1000);',
            ],
            options,
          );
        },
      },
    },
  });
  const server = await projectServer(f);
  try {
    const client = await server.connect();
    client.send({
      type: "command",
      command: {
        id: CommandId.parse("clone-on-socket"),
        deviceId: DeviceId.parse("owner"),
        payload: {
          type: "workspace.clone",
          parent: f.root,
          name: "stalled",
          url: "https://example.invalid/repo.git",
        },
      },
    });
    await until(
      client,
      (message) => message.type === "workspace.clone.progress" && message.phase === "receiving",
    );
    // The same socket asks to cancel while the clone's own command is still in flight.
    client.send({
      type: "projects.request",
      requestId: "cancel",
      operation: { op: "workspace.clone.cancel", commandId: CommandId.parse("clone-on-socket") },
    });
    const replies = [
      await until(client, (m) => m.type === "projects.result" || m.type === "commandResult"),
      await until(client, (m) => m.type === "projects.result" || m.type === "commandResult"),
    ];
    expect(replies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "projects.result",
          result: expect.objectContaining({ kind: "cancelled" }),
        }),
        expect.objectContaining({ type: "commandResult", ok: false, error: "clone_cancelled" }),
      ]),
    );
    expect(f.projects.catalog.recent(100)).toEqual([]);
  } finally {
    await server.close();
    await f.close();
  }
}, 30_000);
