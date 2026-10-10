import { z } from "zod";
import { expect, test } from "vitest";
import {
  readFile,
  writeFile,
  readdir,
  lstat,
  rm,
  symlink,
  mkdtemp,
  mkdir,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { openRegistry } from "@ace/accounts";
import { DeviceId, type ClientMessage } from "@ace/protocol";
import { startDaemon, readConfig, AdapterRegistry } from "@ace/daemon";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { Client } from "./socket-test-support.ts";
import { cursorSdkDiscovery } from "./testing/cursor-sdk-discovery.ts";
import { harness, poll } from "./account-management-test-support.ts";

test("socket account lifecycle isolates login, refreshes models, persists defaults and unregisters without deleting homes", async () => {
  const f = await harness();
  try {
    const account = await f.add();
    const home = join(f.dataDir, "account-homes", account.id);
    expect((await lstat(home)).mode & 0o777).toBe(0o700);
    const login = await f.flow(account.id, "login");
    await poll(async () => (await f.status(account.id))?.quota.auth).toBe("logged_in");
    const list = await f.request(f.owner, { type: "accounts.list", requestId: f.rid() });
    expect(list).toMatchObject({
      accounts: expect.arrayContaining([
        expect.objectContaining({ id: account.id, availability: "available" }),
        expect.objectContaining({
          id: "codex-cli-default",
          implicit: true,
          label: "Your CLI login",
        }),
      ]),
    });
    expect(JSON.stringify(list)).not.toContain(home);
    const second = await f.add();
    await f.flow(second.id, "login");
    await poll(async () => (await f.status(second.id))?.quota.auth).toBe("logged_in");
    expect(await f.status(account.id)).toMatchObject({ quota: { auth: "logged_in" } });
    expect(
      await f.request(f.owner, {
        type: "terminal.request",
        requestId: f.rid(),
        operation: {
          op: "subscribe",
          terminalId: login.terminalId,
          subscriptionId: "late",
          fromOffset: 0,
        },
      }),
    ).toMatchObject({ type: "terminal.result", ok: false });
    await poll(async () => {
      const reply = await f.request(f.owner, {
        type: "models.list",
        requestId: f.rid(),
        options: { instance: account.id, offset: 0, limit: 10 },
      });
      return reply.type === "models.result" && "models" in reply.result
        ? reply.result.models.map((model) => model.nativeModelId)
        : [];
    }).toEqual(["fixture-account-model"]);
    expect(
      await f.request(f.owner, {
        type: "accounts.rename",
        requestId: f.rid(),
        instanceId: account.id,
        label: "Team",
      }),
    ).toMatchObject({ account: { label: "Team" } });
    expect(
      await f.request(f.owner, {
        type: "accounts.setDefault",
        requestId: f.rid(),
        provider: "codex",
        instanceId: account.id,
      }),
    ).toMatchObject({ account: { isDefault: true } });
    const reopened = await openRegistry(join(f.dataDir, "accounts.sqlite"));
    try {
      expect(reopened.summary(account.id, 100)).toMatchObject({ label: "Team", isDefault: true });
    } finally {
      reopened.close();
    }
    await f.flow(account.id, "logout");
    await poll(async () => (await f.status(account.id))?.quota.auth).toBe("logged_out");
    await poll(() => f.models.list({ instance: account.id }).models).toEqual([]);
    expect(
      await f.request(f.owner, {
        type: "accounts.remove",
        requestId: f.rid(),
        instanceId: account.id,
        deleteHome: false,
      }),
    ).toMatchObject({ type: "accounts.changed", account: null });
    expect(await f.status(account.id)).toBeNull();
    expect((await lstat(home)).isDirectory()).toBe(true);
    expect(await f.status("codex-cli-default")).toMatchObject({ implicit: true, isDefault: true });
    for (const filename of ["accounts.sqlite", "models.sqlite"]) {
      const bytes = await readFile(join(f.dataDir, filename));
      expect(bytes.toString()).not.toContain("fixture-auth-output-private");
      expect(bytes.toString()).not.toContain("ambient-fixture-value");
    }
    // Query committed rows through the store: SQLite WAL is part of the logical database.
    expect(JSON.stringify(f.store.readEvents({ afterSeq: 0, limit: 10000 }))).not.toContain(
      "fixture-auth-output-private",
    );
    const payloads = f.store.atomic((db) =>
      db
        .prepare(
          "SELECT item AS value FROM items UNION ALL SELECT bytes FROM blobs UNION ALL SELECT bytes FROM output_chunks UNION ALL SELECT append FROM item_text_chunks",
        )
        .all()
        .map((row) =>
          typeof row.value === "string"
            ? row.value
            : row.value instanceof Uint8Array
              ? Buffer.from(row.value).toString("utf8")
              : "",
        )
        .join("\n"),
    );
    expect(payloads).not.toContain("fixture-auth-output-private");
    expect(await readdir(f.normalHome)).toEqual(["untouched"]);
  } finally {
    await f.close();
  }
});

test.each([
  ["codex", ["login"], "CODEX_HOME"],
  ["claude", ["auth", "login"], "CLAUDE_CONFIG_DIR"],
  ["opencode", ["auth", "login"], "XDG_DATA_HOME"],
  ["pi", [], "PI_CODING_AGENT_DIR"],
] as const)(
  "%s auth terminals run only the selected CLI with private environment and explicit home deletion",
  async (provider, args, selector) => {
    const f = await harness();
    try {
      const account = await f.add(provider);
      const home = join(f.dataDir, "account-homes", account.id);
      const flow = await f.flow(account.id, "login");
      if (provider === "pi") expect(flow.instruction).toBe("/login");
      const launch: unknown = JSON.parse(await readFile(join(home, "fixture-launch.json"), "utf8"));
      const record = z
        .object({ args: z.array(z.string()), env: z.record(z.string(), z.string().nullable()) })
        .parse(launch);
      expect(record.args).toEqual(args);
      expect(record.env[selector]).toBe(provider === "opencode" ? join(home, "data") : home);
      expect(record.env.HOME).toBe(join(home, "user"));
      expect(record.env.TMPDIR).toBe(home);
      expect(record.env.OPENAI_API_KEY).toBeNull();
      // Completion and refresh finish before account changes are admitted again.
      await poll(async () => {
        const result = await f.request(f.owner, {
          type: "accounts.rename",
          requestId: f.rid(),
          instanceId: account.id,
          label: "Ready",
        });
        return result.type;
      }).toBe("accounts.changed");
      const invocations = (await readFile(join(f.dataDir, "fixture-invocations.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => z.object({ provider: z.string() }).parse(JSON.parse(line)));
      expect(new Set(invocations.map((invocation) => invocation.provider))).toEqual(
        new Set([provider]),
      );

      expect(
        await f.request(f.owner, {
          type: "accounts.remove",
          requestId: f.rid(),
          instanceId: account.id,
          deleteHome: true,
        }),
      ).toMatchObject({ type: "accounts.changed", account: null });
      await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(f.normalHome)).toEqual(["untouched"]);
    } finally {
      await f.close();
    }
  },
);

test("Cursor SDK browser sign-in uses its private environment and deletes homes only when requested", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-cursor-managed-")));
  const dataDir = join(root, "daemon");
  const normalHome = join(root, "normal-home");
  await mkdir(normalHome);
  await writeFile(join(normalHome, "untouched"), "editor home sentinel");
  const entry = join(root, "auth-sdk.mjs");
  await writeFile(
    entry,
    `
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,existsSync,watch,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
const home = process.env.HOME;
const marker = join(home,'fixture-signed-in');
const output = value => console.log(JSON.stringify(value));
createInterface({input:process.stdin}).on('line', requestLine => {
  const request = JSON.parse(requestLine);
  if(request.method === 'login') {
    mkdirSync(home,{recursive:true});
    writeFileSync(join(dirname(home),'fixture-sdk-launch.json'), JSON.stringify({
      args:process.argv.slice(2),
      env:Object.fromEntries(['HOME','TMPDIR','OPENAI_API_KEY','CURSOR_CONFIG_DIR','AGENT_CLI_CREDENTIAL_STORE'].map(key=>[key,process.env[key] ?? null]))
    }));
    const authorized = watch(home, () => {
      if(!existsSync(join(home,'fixture-authorized'))) return;
      authorized.close();
      writeFileSync(marker,'SDK sign-in sentinel');
      output({id:request.id,result:{status:'logged-in',source:'sdk-store'}});
    });
    output({method:'login-url',params:{url:'https://cursor.com/login?challenge=fixture-sdk'}});
  } else if(request.method === 'status') {
    output({id:request.id,result:existsSync(marker) ? {status:'logged-in',source:'sdk-store'} : {status:'logged-out',source:'none'}});
  } else if(request.method === 'logout') {
    rmSync(marker,{force:true});
    output({id:request.id,result:{status:'logged-out',source:'none'}});
  } else if(request.method === 'models') output({id:request.id,result:[]});
  else output({id:request.id,result:{disposed:true}});
});`,
  );
  const registry = new AdapterRegistry();
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession() {
        throw new Error("This fixture only signs in");
      },
    },
    { installed: true, auth: "unknown", loginHint: "offline" },
  );
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let client: Client | undefined;
  try {
    const env = { HOME: normalHome, PATH: root, OPENAI_API_KEY: "ambient-fixture-value" };
    daemon = await startDaemon({
      config: readConfig({ ACE_HOME: dataDir, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }, root),
      modelInstances: [],
      accounts: { env },
      engine: { registry, cursor: { entry, env, discovery: cursorSdkDiscovery } },
    });
    const socket = new Client(daemon.url);
    client = socket;
    await once(socket.socket, "open");
    socket.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("sdk-auth-test"),
      token: await readFile(daemon.tokenPath, "utf8"),
    });
    await socket.next();
    const request = async (message: ClientMessage) => {
      socket.send(message);
      for (;;) {
        const reply = await socket.next();
        if ("requestId" in message && "requestId" in reply && message.requestId === reply.requestId)
          return reply;
      }
    };
    const added = await request({
      type: "accounts.add",
      requestId: "add",
      provider: "cursor",
      label: "Work",
    });
    if (added.type !== "accounts.changed" || !added.account) throw new Error(JSON.stringify(added));
    const account = added.account;
    const home = join(dataDir, "account-homes", account.id);
    const login = await request({
      type: "cursor.auth.start",
      requestId: "login",
      instanceId: account.id,
    });
    if (login.type !== "cursor.auth.login") throw new Error(JSON.stringify(login));
    const pollLogin = () =>
      request({ type: "cursor.auth.poll", requestId: "poll", loginId: login.loginId });
    let progress = await pollLogin();
    while (progress.type === "cursor.auth.login" && progress.state === "starting")
      progress = await pollLogin();
    expect(progress).toMatchObject({
      state: "browser",
      url: "https://cursor.com/login?challenge=fixture-sdk",
    });
    const launch: unknown = JSON.parse(
      await readFile(join(home, "fixture-sdk-launch.json"), "utf8"),
    );
    const record = z
      .object({ args: z.array(z.string()), env: z.record(z.string(), z.string().nullable()) })
      .parse(launch);
    expect(record.env).toMatchObject({
      HOME: join(home, "user"),
      TMPDIR: home,
      OPENAI_API_KEY: null,
      CURSOR_CONFIG_DIR: null,
      AGENT_CLI_CREDENTIAL_STORE: null,
    });
    expect(record.args).not.toContain("login");
    await writeFile(join(home, "user", "fixture-authorized"), "browser approved");
    do {
      progress = await pollLogin();
    } while (
      progress.type === "cursor.auth.login" &&
      (progress.state === "starting" || progress.state === "browser")
    );
    expect(progress).toMatchObject({
      state: "complete",
      auth: { status: "logged-in", source: "sdk-store" },
    });
    expect(
      await request({ type: "accounts.status", requestId: "status", instanceId: account.id }),
    ).toMatchObject({ account: { quota: { auth: "logged_in" } } });
    const retained = await request({
      type: "accounts.add",
      requestId: "retained",
      provider: "cursor",
      label: "Retained",
    });
    if (retained.type !== "accounts.changed" || !retained.account)
      throw new Error("Missing retained account");
    const retainedHome = join(dataDir, "account-homes", retained.account.id);
    expect(
      await request({
        type: "accounts.remove",
        requestId: "unregister",
        instanceId: retained.account.id,
        deleteHome: false,
      }),
    ).toMatchObject({ type: "accounts.changed", account: null });
    expect((await lstat(retainedHome)).isDirectory()).toBe(true);
    expect(
      await request({
        type: "accounts.remove",
        requestId: "delete",
        instanceId: account.id,
        deleteHome: true,
      }),
    ).toMatchObject({ type: "accounts.changed", account: null });
    await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(retainedHome)).isDirectory()).toBe(true);
    expect(await readdir(normalHome)).toEqual(["untouched"]);
    expect(JSON.stringify(daemon.store.readEvents({ afterSeq: 0, limit: 10000 }))).not.toContain(
      "fixture-sdk",
    );
    expect((await readFile(join(dataDir, "accounts.sqlite"))).toString()).not.toContain(
      "ambient-fixture-value",
    );
  } finally {
    await client?.close();
    await daemon?.close();
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("normal CLI homes cannot be removed and a replaced managed home cannot delete an outside directory", async () => {
  const f = await harness();
  try {
    for (const type of ["accounts.remove", "accounts.login", "accounts.logout"] as const) {
      const message = {
        type,
        requestId: f.rid(),
        instanceId: "codex-cli-default",
        label: "Changed",
        deleteHome: true,
      };
      expect(await f.request(f.owner, message)).toMatchObject({
        type: "error",
        code: "accounts_failed",
      });
    }
    const account = await f.add();
    const home = join(f.dataDir, "account-homes", account.id);
    await rm(home, { recursive: true });
    await symlink(f.normalHome, home);
    expect(
      await f.request(f.owner, {
        type: "accounts.remove",
        requestId: f.rid(),
        instanceId: account.id,
        deleteHome: true,
      }),
    ).toMatchObject({ type: "error", code: "accounts_failed" });
    expect(await f.status(account.id)).not.toBeNull();
    expect(await readdir(f.normalHome)).toEqual(["untouched"]);
  } finally {
    await f.close();
  }
});

test("paired operate and admin devices cannot manage accounts; explicit accounts scope grants access", async () => {
  const f = await harness(true);
  const remote = f.remote;
  if (!remote) throw new Error("Remote harness unavailable");
  try {
    for (const scopes of [["read", "operate"], ["admin"]]) {
      const device = await remote.pair(scopes);
      const ticket = await remote.ticket(device.token);
      const client = await remote.connectTicket(device.device.id, ticket.ticket);
      await client.next();
      const denied = [
        { type: "accounts.add", requestId: f.rid(), provider: "codex", label: "No permission" },
        {
          type: "accounts.rename",
          requestId: f.rid(),
          instanceId: "codex-cli-default",
          label: "No permission",
        },
        {
          type: "accounts.remove",
          requestId: f.rid(),
          instanceId: "codex-cli-default",
          deleteHome: true,
        },
        {
          type: "accounts.setDefault",
          requestId: f.rid(),
          provider: "codex",
          instanceId: "codex-cli-default",
        },
        { type: "accounts.login", requestId: f.rid(), instanceId: "codex-cli-default" },
        { type: "accounts.logout", requestId: f.rid(), instanceId: "codex-cli-default" },
      ] satisfies ClientMessage[];
      for (const message of denied)
        expect(await f.request(client, message)).toMatchObject({
          type: "error",
          code: "forbidden",
        });
      expect(
        await f.request(client, {
          type: "cursor.auth.start",
          requestId: f.rid(),
          instanceId: "cursor-cli-default",
          label: "No permission",
        }),
      ).toMatchObject({ type: "cursor.auth.error", code: "forbidden" });
    }
    const device = await remote.pair(["accounts"]);
    const ticket = await remote.ticket(device.token);
    const client = await remote.connectTicket(device.device.id, ticket.ticket);
    await client.next();
    expect(
      await f.request(client, {
        type: "accounts.add",
        requestId: f.rid(),
        provider: "codex",
        label: "Authorized",
      }),
    ).toMatchObject({ type: "accounts.changed", account: { label: "Authorized" } });
  } finally {
    await f.close();
  }
});

test("auth output belongs to its socket and unsubscribing cancels the CLI before account changes resume", async () => {
  const f = await harness();
  try {
    const account = await f.add();
    const auth = await f.request(f.owner, {
      type: "accounts.login",
      requestId: f.rid(),
      instanceId: account.id,
    });
    if (auth.type !== "accounts.auth") throw new Error("Auth terminal missing");
    const other = await f.connect();
    await other.next();
    expect(
      await f.request(other, {
        type: "terminal.request",
        requestId: f.rid(),
        operation: {
          op: "subscribe",
          terminalId: auth.terminalId,
          subscriptionId: "stolen",
          fromOffset: 0,
        },
      }),
    ).toMatchObject({ type: "terminal.result", ok: false, error: "forbidden" });
    f.owner.send({
      type: "terminal.request",
      requestId: f.rid(),
      operation: {
        op: "subscribe",
        terminalId: auth.terminalId,
        subscriptionId: "live",
        fromOffset: 0,
      },
    });
    expect(await f.owner.next()).toMatchObject({ type: "terminal.result", ok: true });
    let output = "";
    while (!output.includes("fixture-auth-output-private")) {
      const event = await f.owner.next();
      if (event.type === "terminal.output" && event.event.type === "data")
        output += event.event.data;
    }
    expect(
      await f.request(f.owner, {
        type: "accounts.remove",
        requestId: f.rid(),
        instanceId: account.id,
        deleteHome: true,
      }),
    ).toMatchObject({ type: "error", code: "accounts_failed" });
    expect(
      await f.request(f.owner, {
        type: "terminal.request",
        requestId: f.rid(),
        operation: { op: "unsubscribe", subscriptionId: "live" },
      }),
    ).toMatchObject({ type: "terminal.result", ok: true });
    expect(await f.status(account.id)).toMatchObject({ quota: { auth: "logged_out" } });
    expect(
      await f.request(f.owner, {
        type: "accounts.rename",
        requestId: f.rid(),
        instanceId: account.id,
        label: "Cancelled",
      }),
    ).toMatchObject({ type: "accounts.changed", account: { label: "Cancelled" } });
  } finally {
    await f.close();
  }
});

test("removing an account stops its outstanding metadata CLI before deleting the private home", async () => {
  const f = await harness();
  try {
    const account = await f.add();
    const home = join(f.dataDir, "account-homes", account.id);
    await f.flow(account.id, "login");
    await poll(async () => (await f.status(account.id))?.quota.auth).toBe("logged_in");
    // Wait for the login refresh to finish before asking for a deliberately held refresh.
    await poll(
      async () =>
        (
          await f.request(f.owner, {
            type: "accounts.rename",
            requestId: f.rid(),
            instanceId: account.id,
            label: "Ready",
          })
        ).type,
    ).toBe("accounts.changed");
    await writeFile(join(home, "fixture-hold-model"), "hold metadata");
    f.owner.send({ type: "models.refresh", requestId: f.rid(), filter: { instance: account.id } });
    const pidFile = join(home, "fixture-model-pid");
    await poll(async () => {
      try {
        return (await lstat(pidFile)).isFile();
      } catch {
        return false;
      }
    }).toBe(true);
    const pid = z.coerce
      .number()
      .int()
      .positive()
      .parse(await readFile(pidFile, "utf8"));
    expect(
      await f.request(f.owner, {
        type: "accounts.remove",
        requestId: f.rid(),
        instanceId: account.id,
        deleteHome: true,
      }),
    ).toMatchObject({ type: "accounts.changed", account: null });
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});
