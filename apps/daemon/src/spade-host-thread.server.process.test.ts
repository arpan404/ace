import { once } from "node:events";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, test } from "vitest";
import { z } from "zod";
import { Command, DeviceId, ThreadId, type ServerMessage } from "@ace/protocol";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { Client } from "./socket-test-support.ts";
import { spadeRequest } from "./spade/forward.ts";

const fakeSpade = resolve(import.meta.dirname, "__fixtures__/spade/fake-spade.ts");
type Daemon = Awaited<ReturnType<typeof daemonFixture>>["daemon"];

async function until(check: () => boolean, what: string | (() => string)) {
  for (let turn = 0; turn < 500 && !check(); turn++)
    await new Promise((done) => setTimeout(done, 20));
  if (!check())
    throw new Error(`Timed out waiting for ${typeof what === "string" ? what : what()}`);
}
/** Turns Spade on and waits for it, returning its host thread and the credentials it got. */
async function startSpade(daemon: Daemon) {
  await daemon.settings.set("spade.enabled", true, { kind: "global" });
  await until(
    () => daemon.spade?.status().state === "ready",
    () => `Spade to be ready (${JSON.stringify(daemon.spade?.status())})`,
  );
  const thread = daemon.spade?.status().thread;
  const ready = daemon.spade?.ready();
  if (!thread || !ready) throw new Error("Spade has no host thread");
  const answer = await spadeRequest(
    ready.connection,
    { method: "GET", path: "/v1/env" },
    { signal: AbortSignal.timeout(5000), maxBytes: 65536 },
  );
  if (answer.kind !== "response") throw new Error("Spade's env is too large");
  const env = JSON.parse(answer.body.toString("utf8")) as { mcpUrl: string; mcpToken: string };
  return { hostId: ThreadId.parse(thread.id), env };
}
/** Spade's MCP client as spade-ace connects: 2025-11-25 sessions with list changes. */
async function connectMcp(env: { mcpUrl: string; mcpToken: string }) {
  const transport = new StreamableHTTPClientTransport(new URL(env.mcpUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${env.mcpToken}`, "X-Ace-Notifications": "stream" },
    },
  });
  // v1's optional sessionId uses a different exact-optional convention.
  const wire: Transport = {
    start: () => transport.start(),
    close: () => transport.close(),
    send: (message, options) => transport.send(message, options),
  };
  // SDK transports expose callback properties.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onmessage = (message) => wire.onmessage?.(message);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onerror = (error) => wire.onerror?.(error);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = () => wire.onclose?.();
  const client = new McpClient({ name: "spade", version: "0.1.0" });
  await client.connect(wire);
  return { client, transport };
}
async function deleteThread(daemon: Daemon, threadId: ThreadId) {
  const token = await readFile(daemon.tokenPath, "utf8");
  const socket = new Client(daemon.url);
  await once(socket.socket, "open");
  socket.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("desktop"), token });
  const command = Command.parse({
    id: "delete-host",
    deviceId: "desktop",
    payload: { type: "thread.delete", threadId, force: true },
  });
  socket.send({ type: "command", command });
  for (;;) {
    const message: ServerMessage = await socket.next();
    if ("commandId" in message && message.commandId === command.id) {
      await socket.close();
      return message;
    }
  }
}

test("Spade acts as its own hidden host thread: the full agent tool set, delegations as its children, and a host that heals", async ({
  onTestFinished,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-spade-thread-")));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "spade-server");
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakeSpade}"\n`);
  await chmod(binary, 0o755);
  const f = await daemonFixture(undefined, {
    spade: { env: { PATH: process.env.PATH, HOME: root, ACE_SPADE_BIN: binary } },
  });
  let daemon = f.daemon;
  const opened: McpClient[] = [];
  try {
    const { hostId, env } = await startSpade(daemon);
    const host = daemon.store.getThread(hostId);
    expect(host?.host).toBe("spade");

    // The lease is a provider session's: every agent tool group, each tool's risk stated.
    const { client, transport } = await connectMcp(env);
    opened.push(client);
    expect(transport.sessionId).toBeTruthy();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const tool of [
      "delegate",
      "wait",
      "agents_status",
      "agent_message",
      "thread_start",
      "notify",
      "automations_list",
      "guide",
      "tools_find",
    ])
      expect(names).toContain(tool);
    // Nothing that waits on the person inside the hidden host thread.
    expect(names).not.toContain("ask");
    expect(names).not.toContain("browser_request_help");
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint).toBe("boolean");
    }

    // A delegation names a local project and runs there, as the host thread's child.
    const delegated = await client.callTool({
      name: "delegate",
      arguments: {
        tasks: [
          {
            requestId: "spade.c1.1",
            task: "Say hello",
            role: "Greeter-in-project",
            provider: "codex",
            project: f.workspace,
          },
        ],
      },
    });
    expect(delegated.isError).toBeFalsy();
    const childId = ThreadId.parse(
      z
        .object({ data: z.object({ threadIds: z.array(z.string()).length(1) }) })
        .parse(delegated.structuredContent).data.threadIds[0],
    );
    await until(() => daemon.store.getThread(childId) !== undefined, "the delegated child");
    const child = daemon.store.getThread(childId);
    if (!child) throw new Error("No child");
    expect(child.workspaceId).toBe(f.workspace);
    expect(daemon.agentControl?.delegations.journal.get(child.id)?.parentId).toBe(hostId);

    // Lists show the child, never the host thread or Spade's project.
    const listed = daemon.store.sidebarPage({ limit: 100 });
    const ids = listed.threads.map((entry) => entry.id);
    expect(ids).toContain(child.id);
    expect(ids).not.toContain(hostId);
    const projects = daemon.projects?.catalog.page(undefined, 100).projects.map((each) => each.id);
    expect(projects).toContain(f.workspace);
    expect(projects).not.toContain(host?.workspaceId);

    // Nothing runs in the host thread itself.
    expect(
      f.controls.delegations.command("send-to-host", {
        type: "thread.send",
        threadId: hostId,
        input: [{ type: "text", text: "hello" }],
      }),
    ).toMatchObject({ ok: false, error: "host_thread" });

    // Its access is the person's default, followed live and on every start.
    const access = () => daemon.store.getThread(hostId)?.permission?.effective;
    expect(access()).toBe("full-access");
    await daemon.settings.set("access.defaultMode", "auto-review", { kind: "global" });
    await until(
      () => access() === "auto-review",
      () => `host access auto-review (${access()})`,
    );
    await daemon.settings.set("spade.enabled", false, { kind: "global" });
    await until(() => daemon.spade?.status().state === "off", "Spade to stop");
    await daemon.settings.set("access.defaultMode", "read-only", { kind: "global" });
    await client.close();
    const restarted = await startSpade(daemon);
    expect(restarted.hostId).toBe(hostId);
    expect(access()).toBe("read-only");
    const narrowed = await connectMcp(restarted.env);
    opened.push(narrowed.client);
    const stricter = await narrowed.client.callTool({
      name: "delegate",
      arguments: {
        tasks: [
          {
            requestId: "spade.c1.2",
            task: "Look around",
            role: "Reader-in-project",
            provider: "codex",
            project: f.workspace,
          },
        ],
      },
    });
    const stricterId = ThreadId.parse(
      z
        .object({ data: z.object({ threadIds: z.array(z.string()).length(1) }) })
        .parse(stricter.structuredContent).data.threadIds[0],
    );
    const childAccess = () => {
      const permission = daemon.store.getThread(stricterId)?.permission;
      return permission?.effective ?? permission?.override;
    };
    await until(() => childAccess() != null, "the stricter child's access");
    expect(childAccess()).toBe("read-only");

    // Its provider is the person's default too: a delegation that names none takes the new one.
    await daemon.settings.set("access.defaultMode", "full-access", { kind: "global" });
    await until(() => access() === "full-access", "host access full-access");
    const before = daemon.store.getThread(hostId)?.provider;
    const other = before === "codex" ? "claude" : "codex";
    await daemon.settings.set("providers.default", other, { kind: "global" });
    await until(
      () => daemon.store.getThread(hostId)?.provider === other,
      () => `host provider ${other} (${daemon.store.getThread(hostId)?.provider})`,
    );
    const unnamed = await narrowed.client.callTool({
      name: "delegate",
      arguments: {
        tasks: [
          {
            requestId: "spade.c1.3",
            task: "Note the relay's version",
            role: "Noter-in-project",
            project: f.workspace,
          },
        ],
      },
    });
    const unnamedId = ThreadId.parse(
      z
        .object({ data: z.object({ threadIds: z.array(z.string()).length(1) }) })
        .parse(unnamed.structuredContent).data.threadIds[0],
    );
    await until(() => daemon.store.getThread(unnamedId) !== undefined, "the unnamed child");
    expect(daemon.store.getThread(unnamedId)?.provider).toBe(other);

    // Deleted, it is made again on the next start, in the same hidden project.
    expect(await deleteThread(daemon, hostId)).toMatchObject({ ok: true });
    daemon = await f.restart();
    const again = await startSpade(daemon);
    expect(again.hostId).not.toBe(hostId);
    // The child Spade delegated before keeps its history.
    expect(daemon.store.getThread(childId)).toMatchObject({ id: childId });
    expect(daemon.store.getThread(childId)?.deletedAt).toBeUndefined();
    expect(daemon.store.getThread(again.hostId)?.workspaceId).toBe(host?.workspaceId);
    const second = await connectMcp(again.env);
    opened.push(second.client);
    expect((await second.client.listTools()).tools.map((tool) => tool.name)).toContain("delegate");
  } finally {
    for (const client of opened) await client.close().catch(() => {});
    await daemon.close();
  }
}, 30_000);
