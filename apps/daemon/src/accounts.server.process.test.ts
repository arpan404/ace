import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountService, openRegistry, createInstance } from "@ace/accounts";
import { AccountSummary } from "@ace/protocol/accounts";
import { fixture } from "./socket-test-support.ts";
import { cursorSdkDiscovery } from "./testing/cursor-sdk-discovery.ts";
test("authenticated sockets list and query accounts without exposing filesystem selectors", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-accounts-wire-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  await registry.register(
    createInstance({ id: "a", provider: "codex", homeDir: join(root, "home"), label: "Work" }),
  );
  const f = await fixture({
    accounts: new AccountService({ registry, now: () => 1, timeZone: "UTC", env: {} }),
  });
  try {
    const stranger = await f.open();
    stranger.send({ type: "accounts.list", requestId: "forbidden" });
    expect(await stranger.next()).toMatchObject({ type: "error", code: "unauthorized" });
    const client = await f.connect();
    await client.next();
    client.send({ type: "accounts.list", requestId: "list" });
    const response = await client.next();
    expect(response).toMatchObject({
      type: "accounts.list",
      requestId: "list",
      accounts: [{ id: "a", label: "Work", availability: "unknown" }],
    });
    expect(JSON.stringify(response)).not.toContain(root);
    client.send({ type: "accounts.status", requestId: "status", instanceId: "a" });
    expect(await client.next()).toMatchObject({ type: "accounts.status", account: { id: "a" } });
    client.send({ type: "accounts.status", requestId: "missing", instanceId: "missing" });
    expect(await client.next()).toEqual({
      type: "accounts.status",
      requestId: "missing",
      account: null,
    });
    client.send({
      type: "accounts.migrate",
      requestId: "migrate",
      provider: "codex",
      nativeSessionId: "opaque",
      from: "a",
      to: "missing",
    });
    expect(await client.next()).toMatchObject({
      type: "accounts.migrate",
      result: { status: "refused", reason: "Unknown instance" },
    });
  } finally {
    await f.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("the accounts CLI and default daemon routes share the ACE_HOME registry", async () => {
  const { startDaemon } = await import("./index.ts");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { once } = await import("node:events");
  const { Client } = await import("./socket-test-support.ts");
  const root = await mkdtemp(join(tmpdir(), "ace-accounts-default-"));
  const statusStarted = Promise.withResolvers<void>();
  const statusReleased = Promise.withResolvers<void>();
  // The daemon's normal metadata refresh may update the shared registry between CLI reads.
  // Hold the SDK's read-only status reply to exercise that race without a real provider login.
  const statusGate = createServer((_request, response) => {
    statusStarted.resolve();
    void statusReleased.promise.then(() => {
      if (!response.destroyed) response.end();
    });
  });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let client: InstanceType<typeof Client> | undefined;
  try {
    statusGate.listen(0, "127.0.0.1");
    await once(statusGate, "listening");
    const address = statusGate.address();
    if (!address || typeof address === "string") throw new Error("Missing status gate address");
    const entry = join(root, "sdk-status.mjs");
    await writeFile(
      entry,
      `import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', async line => {
  const request = JSON.parse(line);
  if (request.method === 'status') await fetch(${JSON.stringify(`http://127.0.0.1:${address.port}`)});
  const result = request.method === 'status' ? {status:'logged-out',source:'none'} :
    request.method === 'models' ? [] : {disposed:true};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});`,
    );
    const registry = await openRegistry(join(root, "accounts.sqlite"));
    try {
      await registry.register(
        createInstance({
          id: "shared",
          provider: "codex",
          label: "Shared",
          homeDir: join(root, "provider"),
        }),
      );
    } finally {
      registry.close();
    }
    daemon = await startDaemon({
      engine: { cursor: { entry, discovery: cursorSdkDiscovery } },
      config: {
        dataDir: root,
        host: "127.0.0.1",
        port: 0,
        logLevel: "silent",
        listen: "local",
        remotePort: 0,
      },
    });
    client = new Client(daemon.url);
    await once(client.socket, "open");
    const list = async (path: string) =>
      AccountSummary.array()
        .max(256)
        .parse(
          JSON.parse(
            (
              await promisify(execFile)(process.execPath, [path, "accounts", "list"], {
                env: { ...process.env, ACE_HOME: root, ACE_ACCOUNTS_DB: undefined },
              })
            ).stdout,
          ),
        );
    await statusStarted.promise;
    expect(await list("packages/accounts/src/cli.ts")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cursor-sdk-default",
          availability: "unknown",
          quota: expect.objectContaining({ auth: "unknown" }),
        }),
      ]),
    );
    const { readFile } = await import("node:fs/promises");
    const actualToken = (await readFile(daemon.tokenPath, "utf8")).trim();
    client.socket.send(
      JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: "device", token: actualToken }),
    );
    await client.next();
    client.send({ type: "providers.request", requestId: "ready", operation: "refresh" });
    statusReleased.resolve();
    const ready = await client.next();
    expect(ready).toMatchObject({
      type: "providers.result",
      requestId: "ready",
      result: { ok: true },
    });
    // Compare complete snapshots only after the real daemon's initial discovery has committed.
    const accounts: unknown = await list("packages/accounts/src/cli.ts");
    expect(accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "shared", label: "Shared" })]),
    );
    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cursor-sdk-default",
          availability: "logged_out",
          quota: expect.objectContaining({ auth: "logged_out" }),
        }),
      ]),
    );
    expect(await list("apps/daemon/src/cli.ts")).toEqual(accounts);
    client.send({ type: "accounts.list", requestId: "list" });
    expect(await client.next()).toEqual({ type: "accounts.list", requestId: "list", accounts });
  } finally {
    statusReleased.resolve();
    try {
      try {
        await client?.close();
      } finally {
        await daemon?.close();
      }
    } finally {
      try {
        if (statusGate.listening)
          await new Promise<void>((resolve, reject) =>
            statusGate.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
test("paired read devices can inspect accounts but migration requires operate scope", async () => {
  const { setup } = await import("./remote-test-support.ts");
  const root = await mkdtemp(join(tmpdir(), "ace-accounts-scopes-"));
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  await registry.register(
    createInstance({ id: "a", provider: "codex", label: "A", homeDir: join(root, "home") }),
  );
  const f = await setup({
    accounts: new AccountService({ registry, now: () => 1, timeZone: "UTC", env: {} }),
  });
  try {
    const read = await f.pair(["read"]);
    const readTicket = await f.ticket(read.token);
    const reader = await f.connectTicket(read.device.id, readTicket.ticket);
    await reader.next();
    reader.send({ type: "accounts.list", requestId: "list" });
    expect(await reader.next()).toMatchObject({ accounts: [{ id: "a" }] });
    reader.send({ type: "accounts.status", requestId: "status", instanceId: "a" });
    expect(await reader.next()).toMatchObject({ account: { id: "a" } });
    reader.send({
      type: "accounts.migrate",
      requestId: "m",
      provider: "codex",
      nativeSessionId: "opaque",
      from: "a",
      to: "missing",
    });
    expect(await reader.next()).toMatchObject({ type: "error", code: "forbidden" });
    const operate = await f.pair(["operate"]);
    const operateTicket = await f.ticket(operate.token);
    const operator = await f.connectTicket(operate.device.id, operateTicket.ticket);
    await operator.next();
    operator.send({ type: "accounts.list", requestId: "list" });
    expect(await operator.next()).toMatchObject({ type: "error", code: "forbidden" });
    operator.send({ type: "accounts.status", requestId: "s", instanceId: "a" });
    expect(await operator.next()).toMatchObject({ type: "error", code: "forbidden" });
    operator.send({
      type: "accounts.migrate",
      requestId: "m",
      provider: "codex",
      nativeSessionId: "opaque",
      from: "a",
      to: "missing",
    });
    expect(await operator.next()).toMatchObject({
      result: { status: "refused", reason: "Unknown instance" },
    });
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
