import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountService, openRegistry, createInstance } from "@ace/accounts";
import { fixture } from "./socket-test-support.ts";
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
  const registry = await openRegistry(join(root, "accounts.sqlite"));
  await registry.register(
    createInstance({
      id: "shared",
      provider: "codex",
      label: "Shared",
      homeDir: join(root, "provider"),
    }),
  );
  registry.close();
  const daemon = await startDaemon({
    dataDir: root,
    host: "127.0.0.1",
    port: 0,
    logLevel: "silent",
  });
  const client = new Client(daemon.url);
  try {
    await once(client.socket, "open");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["packages/accounts/src/cli.ts", "accounts", "list"],
      { env: { ...process.env, ACE_HOME: root, ACE_ACCOUNTS_DB: undefined } },
    );
    expect(JSON.parse(stdout)).toMatchObject([{ id: "shared", label: "Shared" }]);
    const { readFile } = await import("node:fs/promises");
    const actualToken = (await readFile(daemon.tokenPath, "utf8")).trim();
    client.socket.send(
      JSON.stringify({ type: "hello", protocolVersion: 1, deviceId: "device", token: actualToken }),
    );
    await client.next();
    client.send({ type: "accounts.list", requestId: "list" });
    expect(await client.next()).toMatchObject({ accounts: [{ id: "shared", label: "Shared" }] });
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
