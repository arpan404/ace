import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, realpath, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { z } from "zod";
import { ServerMessage } from "@ace/protocol";
import { PluginServerMessage, type PluginRequest } from "@ace/protocol/plugins";
import { expect, test } from "vitest";
import { startDaemon } from "./index.ts";

const execute = promisify(execFile);
test("authenticated daemon installation is reviewed, survives restart and supplies materialized adapter overrides", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-plugin-wire-")));
  const repo = join(root, "repo");
  const config = {
    dataDir: join(root, "daemon"),
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
    listen: "local",
    remotePort: 0,
  } satisfies Parameters<typeof startDaemon>[0];
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let socket: WebSocket | undefined;
  try {
    await mkdir(repo);
    const git = (args: string[]) =>
      execute("git", args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
      });
    await git(["init", "-b", "main"]);
    await writeFile(
      join(repo, "marketplace.json"),
      JSON.stringify({ name: "test", plugins: [{ name: "sample", source: "." }] }),
    );
    await writeFile(
      join(repo, "ace-plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "sample",
        version: "1",
        commands: [{ name: "check", path: "check.md" }],
        mcpServers: {
          tools: { type: "stdio", command: process.execPath, args: ["${PLUGIN_ROOT}/server.js"] },
        },
      }),
    );
    await writeFile(join(repo, "check.md"), "Run project checks.");
    await writeFile(join(repo, "server.js"), "console.log('SESSION_RESOURCE');");
    await git(["add", "."]);
    await git(["commit", "-m", "fixture"]);
    daemon = await startDaemon(config);
    socket = new WebSocket(daemon.url);
    await once(socket, "open");
    const received = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "pluginRequest",
        requestId: "unauthenticated",
        request: { type: "plugins.list" },
      }),
    );
    expect(ServerMessage.parse(JSON.parse(String((await received)[0])))).toMatchObject({
      type: "error",
      code: "unauthorized",
    });
    socket.terminate();
    socket = new WebSocket(daemon.url);
    await once(socket, "open");
    const welcome = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        deviceId: "device",
        token: (await readFile(daemon.tokenPath, "utf8")).trim(),
      }),
    );
    expect(ServerMessage.parse(JSON.parse(String((await welcome)[0])))).toMatchObject({
      type: "welcome",
    });
    const client = socket;
    async function request(input: z.input<typeof PluginRequest>) {
      const requestId = randomUUID();
      const pending = once(client, "message");
      client.send(JSON.stringify({ type: "pluginRequest", requestId, request: input }));
      const result = PluginServerMessage.parse(JSON.parse(String((await pending)[0])));
      expect(result.requestId).toBe(requestId);
      return result.response;
    }
    const review = await request({
      type: "plugins.prepare",
      repository: repo,
      ref: "main",
      name: "sample",
    });
    if (review.type !== "plugins.review") throw new Error("Missing review");
    expect(review.review.executions).toContainEqual({
      kind: "stdio",
      name: "tools",
      command: process.execPath,
      args: ["${PLUGIN_ROOT}/server.js"],
      env: {},
    });
    expect(await request({ type: "plugins.list" })).toMatchObject({
      installs: [],
      reviews: [{ id: review.review.id, executionCount: review.review.executions.length }],
    });
    expect(await request({ type: "plugins.readReview", id: review.review.id })).toMatchObject({
      type: "plugins.reviewPage",
      entries: [{ type: "execution", execution: { name: "tools" } }],
    });
    expect(
      await request({
        type: "plugins.accept",
        id: review.review.id,
        commit: review.review.commit,
        hash: review.review.hash,
      }),
    ).toMatchObject({ type: "plugins.installed" });
    const session = await daemon.preparePlugins("acp", join(root, "acp-session"));
    const server = z
      .object({ command: z.string(), args: z.array(z.string()) })
      .parse(session.sessionConfig.mcpServers?.[0]);
    expect((await execute(server.command, server.args)).stdout.trim()).toBe("SESSION_RESOURCE");
    await request({ type: "plugins.remove", name: "sample" });
    expect((await execute(server.command, server.args)).stdout.trim()).toBe("SESSION_RESOURCE");
    await session.close();
    await expect(execute(server.command, server.args)).rejects.toThrow();
    const next = await request({
      type: "plugins.prepare",
      repository: repo,
      ref: "main",
      name: "sample",
    });
    if (next.type !== "plugins.review") throw new Error("Missing review");
    await request({
      type: "plugins.accept",
      id: next.review.id,
      commit: next.review.commit,
      hash: next.review.hash,
    });
    socket.terminate();
    await daemon.close();
    daemon = await startDaemon(config);
    const restarted = await daemon.preparePlugins("claude", join(root, "claude-session"));
    expect(restarted.args).toContain("--plugin-dir");
    expect(
      await readFile(
        join(root, "claude-session/generated/plugins/sample/commands/check.md"),
        "utf8",
      ),
    ).toBe("Run project checks.");
    await restarted.close();
    const marker = join(root, "native-invocation.json");
    const script = join(root, "native.cjs");
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const launched = await daemon.launchPlugins("claude", join(root, "native-session"), {
      command: process.execPath,
      args: [script],
      env: {},
      name: "test-native",
    });
    expect((await launched.exited).code).toBe(0);
    expect(z.array(z.string()).parse(JSON.parse(await readFile(marker, "utf8")))).toContain(
      "--plugin-dir",
    );
    await expect(
      readFile(join(root, "native-session/generated/plugins/sample/commands/check.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    socket?.terminate();
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
});
