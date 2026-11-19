import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { Command, DeviceId, ThreadId, type ServerMessage } from "@ace/protocol";
import { fakeSpadeService } from "./__fixtures__/spade/fake-service.ts";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { Client } from "./socket-test-support.ts";
import { aceMcpUrl, adminSocket, connectSpadeMcp, spadeEnv, until } from "./spade-test-support.ts";

type Daemon = Awaited<ReturnType<typeof daemonFixture>>["daemon"];

/** Turns Spade on and waits for it to hold its grant, returning its host thread and the grant. */
async function startSpade(daemon: Daemon) {
  await daemon.settings.set("spade.enabled", true, { kind: "global" });
  await until(
    () => daemon.spade?.status().state === "ready",
    () => `Spade to be ready (${JSON.stringify(daemon.spade?.status())})`,
  );
  const grant = await until(async () => (await spadeEnv(daemon)).grant, "Spade's grant");
  const thread = daemon.spade?.status().thread;
  if (!thread) throw new Error("Spade has no host thread");
  return { hostId: ThreadId.parse(thread.id), grant, url: aceMcpUrl(daemon) };
}
/** Spade's MCP client as spade-ace connects. */
const connectMcp = (spade: { url: string; grant: string }) =>
  connectSpadeMcp(spade.url, spade.grant);
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

test("Spade acts as its own hidden host thread: the full agent tool set, delegations as its children, and a host that heals", async () => {
  let home = "";
  const service = fakeSpadeService(() => home);
  const f = await daemonFixture(undefined, {
    spade: { service: service.control, pollMs: { waiting: 50, ready: 200 } },
  });
  home = join(f.h.home, "daemon");
  let daemon = f.daemon;
  const opened: Awaited<ReturnType<typeof connectSpadeMcp>>[] = [];
  try {
    const spade = await startSpade(daemon);
    const { hostId } = spade;
    const host = daemon.store.getThread(hostId);
    expect(host?.host).toBe("spade");

    // The lease is a provider session's: every agent tool group, each tool's risk stated.
    const client = await connectMcp(spade);
    opened.push(client);
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
    const narrowed = { client: await connectMcp(restarted) };
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

    // Deleted, it is made again when the daemon next starts with Spade's grant live, in the same
    // hidden project; Spade keeps running and its grant now acts as the new thread.
    expect(await deleteThread(daemon, hostId)).toMatchObject({ ok: true });
    daemon = await f.restart();
    const again = await startSpade(daemon);
    expect(again.hostId).not.toBe(hostId);
    // The child Spade delegated before keeps its history.
    expect(daemon.store.getThread(childId)).toMatchObject({ id: childId });
    expect(daemon.store.getThread(childId)?.deletedAt).toBeUndefined();
    expect(daemon.store.getThread(again.hostId)?.workspaceId).toBe(host?.workspaceId);
    expect(again.grant).toBe(restarted.grant);
    const second = await connectMcp(again);
    opened.push(second);
    expect((await second.listTools()).tools.map((tool) => tool.name)).toContain("delegate");

    // With Spade off, a restarted daemon still names the host thread, so the apps know Spade's
    // children by their parent.
    await daemon.settings.set("spade.enabled", false, { kind: "global" });
    await until(() => daemon.spade?.status().state === "off", "Spade to stop");
    for (const session of opened) await session.close().catch(() => {});
    opened.length = 0;
    daemon = await f.restart();
    await until(
      () => daemon.spade?.status().thread !== undefined,
      () => `the host thread in Spade's status (${JSON.stringify(daemon.spade?.status())})`,
    );
    expect(daemon.spade?.status()).toMatchObject({
      state: "off",
      thread: { id: again.hostId, busy: false },
    });
  } finally {
    for (const client of opened) await client.close().catch(() => {});
    await daemon.close();
    await service.close();
  }
}, 30_000);

test("Spade names a bot on its own calls: the person driving that bot's computer refuses its browser tools", async () => {
  let home = "";
  const service = fakeSpadeService(() => home);
  const f = await daemonFixture(undefined, {
    spade: { service: service.control, pollMs: { waiting: 50, ready: 200 } },
  });
  home = join(f.h.home, "daemon");
  let { daemon } = f;
  const socket = await adminSocket(daemon);
  let client: Awaited<ReturnType<typeof connectSpadeMcp>> | undefined;
  try {
    const spade = await startSpade(daemon);
    client = await connectMcp(spade);
    expect(
      await socket.ask({
        type: "spade.computer.drive",
        requestId: "take",
        bot: "fares",
        driver: "person",
      }),
    ).toEqual({
      type: "spade.computer.drive.result",
      requestId: "take",
      driver: "person",
      mode: "exclusive",
      stopped: true,
    });
    const refused = await client.callTool({
      name: "browser_tabs",
      arguments: { action: "list" },
      _meta: { "ace/acting-for": "fares" },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("person_driving");
    // Nothing opened for it: no thread of its own yet, no tabs, no screen.
    expect(
      await socket.ask({ type: "spade.computer.get", requestId: "get", bot: "fares" }),
    ).toEqual({
      type: "spade.computer.result",
      requestId: "get",
      computer: {
        bot: "fares",
        driver: "person",
        mode: "exclusive",
        browser: { tabs: [] },
        screen: { apps: [] },
      },
    });
    expect(daemon.spade?.status().thread?.id).toBe(spade.hostId);

    // A daemon restart leaves the person driving: the take-over is kept on disk.
    await client.close();
    client = undefined;
    await socket.close();
    daemon = await f.restart();
    const again = await startSpade(daemon);
    client = await connectMcp(again);
    const still = await client.callTool({
      name: "browser_tabs",
      arguments: { action: "list" },
      _meta: { "ace/acting-for": "fares" },
    });
    expect(JSON.stringify(still.content)).toContain("person_driving");
  } finally {
    await client?.close().catch(() => {});
    await socket.close().catch(() => {});
    await daemon.close();
    await service.close();
  }
}, 30_000);
