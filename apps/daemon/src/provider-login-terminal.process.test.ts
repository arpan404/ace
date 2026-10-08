import { expect, test } from "vitest";
import { mkdir, readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderLoginSessions } from "@ace/accounts";
import { DeviceId, SocketTicket, type ServerMessage } from "@ace/protocol";
import { harness } from "./account-management-test-support.ts";
import { fixture, type Client } from "./socket-test-support.ts";
import { accessRequest } from "./client-access.ts";
import { manualLogin } from "./provider-login-driver.ts";

async function next(
  client: Client,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> {
  for (;;) {
    const message = await client.next();
    if (predicate(message)) return message;
  }
}

test("operate-only native terminal fallback uses the default CLI profile and has no replay", async () => {
  const f = await harness();
  const defaultHome = join(f.normalHome, ".codex");
  await mkdir(defaultHome);
  const env: NodeJS.ProcessEnv = f.env;
  env.CODEX_HOME = defaultHome;
  const sessions = new ProviderLoginSessions({
    now: () => 1000,
    id: () => "fallback-login",
    schedule: () => () => {},
    prepare: async () => ({
      run: async () => ({ success: false, manual: manualLogin("codex", "login") }),
    }),
  });
  const server = await fixture({
    providerLogin: sessions,
    accounts: f.accounts,
    accountManagement: f.management,
  });
  try {
    const device = server.store.devices.create("Phone", ["read", "operate"], 1000);
    const ticket = SocketTicket.parse(
      await accessRequest(server.server.httpUrl, "/v1/tickets", {
        method: "POST",
        token: device.token,
      }),
    );
    const client = await server.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(device.device.id),
      ticket: ticket.ticket,
    });
    await client.next();
    client.send({ type: "provider.login.start", requestId: "start", provider: "codex" });
    await next(
      client,
      (message) =>
        message.type === "provider.login.progress" && message.progress.state === "failed",
    );
    client.send({ type: "provider.login.terminal", requestId: "open", session: "fallback-login" });
    const result = await next(
      client,
      (message) => message.type === "provider.login.result" && message.requestId === "open",
    );
    if (
      result.type !== "provider.login.result" ||
      !result.result.ok ||
      !result.result.progress.manual?.terminalId
    )
      throw new Error("Missing native terminal");
    const terminalId = result.result.progress.manual.terminalId;
    client.send({ type: "provider.login.terminal", requestId: "retry", session: "fallback-login" });
    expect(
      await next(
        client,
        (message) => message.type === "provider.login.result" && message.requestId === "retry",
      ),
    ).toMatchObject({ result: { progress: { manual: { terminalId } } } });
    client.send({
      type: "terminal.request",
      requestId: "subscribe",
      operation: { op: "subscribe", terminalId, subscriptionId: "auth", fromOffset: 0 },
    });
    expect(await next(client, (message) => message.type === "terminal.result")).toMatchObject({
      ok: true,
    });
    await next(
      client,
      (message) =>
        message.type === "terminal.output" &&
        message.event.type === "data" &&
        message.event.data.includes("fixture-auth-output-private"),
    );
    client.send({
      type: "terminal.request",
      requestId: "finish",
      operation: { op: "write", terminalId, data: "finish\n" },
    });
    expect(
      await next(
        client,
        (message) => message.type === "terminal.output" && message.event.type === "exit",
      ),
    ).toMatchObject({ event: { status: { code: 0 } } });
    client.send({
      type: "terminal.request",
      requestId: "drain",
      operation: { op: "close", terminalId },
    });
    await next(
      client,
      (message) => message.type === "terminal.result" && message.requestId === "drain",
    );
    expect(await readFile(join(defaultHome, "fixture-signed-in"), "utf8")).toBe("fixture marker");
    expect(f.registry.summary("codex-cli-default", 1000)).toMatchObject({
      quota: { auth: "logged_in" },
    });
    client.send({
      type: "terminal.request",
      requestId: "replay",
      operation: { op: "subscribe", terminalId, subscriptionId: "late", fromOffset: 0 },
    });
    expect(
      await next(
        client,
        (message) => message.type === "terminal.result" && message.requestId === "replay",
      ),
    ).toMatchObject({ ok: false, error: "forbidden" });
  } finally {
    await server.close();
    await sessions.close();
    await f.close();
  }
});

test("Cursor browser sign-in cannot create a native CLI fallback or reserve its SDK account", async () => {
  const f = await harness();
  try {
    const added = await f.management.handle("settings", {
      type: "accounts.add",
      requestId: "add-cursor",
      provider: "cursor",
      label: "Cursor SDK",
    });
    if (added.type !== "accounts.changed" || !added.account) throw new Error("Missing SDK account");
    const instanceId = added.account.id;
    expect(() => f.management.openProviderTerminal("phone", instanceId, "login")).toThrow(
      "Unsupported auth terminal",
    );
    const release = f.accounts.reserveAccountChange(added.account.id);
    release();
    await expect(
      readFile(join(f.dataDir, "account-homes", added.account.id, "fixture-launch.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("an agent-owned sign-in terminal belongs to its paired device and never exposes replay", async () => {
  const f = await harness();
  const server = await fixture({ accountManagement: f.management });
  const command = join(f.dataDir, "interactive-agent");
  await writeFile(
    command,
    `#!${process.execPath}\nconsole.log('agent-login-private');process.stdin.on('data',()=>process.exit(0));\n`,
    { mode: 0o700 },
  );
  try {
    const device = server.store.devices.create("Phone", ["read", "operate"], 1000);
    const ticket = SocketTicket.parse(
      await accessRequest(server.server.httpUrl, "/v1/tickets", {
        method: "POST",
        token: device.token,
      }),
    );
    const client = await server.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(device.device.id),
      ticket: ticket.ticket,
    });
    await client.next();
    const terminal = f.management.openLoginTerminal(device.device.id, {
      shell: command,
      args: [],
      env: { HOME: f.normalHome, PATH: "" },
      cwd: f.dataDir,
      cols: 80,
      rows: 24,
      name: "Agent sign-in",
    });
    const other = await server.connect();
    await other.next();
    other.send({
      type: "terminal.request",
      requestId: "other",
      operation: {
        op: "subscribe",
        terminalId: terminal.id,
        subscriptionId: "other",
        fromOffset: 0,
      },
    });
    expect(await next(other, (m) => m.type === "terminal.result")).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    client.send({
      type: "terminal.request",
      requestId: "live",
      operation: {
        op: "subscribe",
        terminalId: terminal.id,
        subscriptionId: "live",
        fromOffset: 0,
      },
    });
    expect(await next(client, (m) => m.type === "terminal.result")).toMatchObject({ ok: true });
    await next(
      client,
      (m) =>
        m.type === "terminal.output" &&
        m.event.type === "data" &&
        m.event.data.includes("agent-login-private"),
    );
    client.send({
      type: "terminal.request",
      requestId: "finish",
      operation: { op: "write", terminalId: terminal.id, data: "finish\n" },
    });
    expect(await terminal.exited).toBe(true);
    client.send({
      type: "terminal.request",
      requestId: "replay",
      operation: {
        op: "subscribe",
        terminalId: terminal.id,
        subscriptionId: "replay",
        fromOffset: 0,
      },
    });
    expect(
      await next(client, (m) => m.type === "terminal.result" && m.requestId === "replay"),
    ).toMatchObject({ ok: false, error: "forbidden" });
  } finally {
    await server.close();
    await f.close();
  }
});
