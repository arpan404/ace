import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderLoginSessions } from "@ace/accounts";
import { type ServerMessage } from "@ace/protocol";
import { harness } from "./account-management-test-support.ts";
import { fixture, type Client } from "./socket-test-support.ts";

async function next(
  client: Client,
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> {
  for (;;) {
    const message = await client.next();
    if (predicate(message)) return message;
  }
}

test("Pi Other starts a live PTY, echoes input, resizes and settles only after a clean exit", async () => {
  const f = await harness();
  const command = join(f.bin, "pi");
  await writeFile(
    command,
    `#!${process.execPath}
console.log('Pi ready. Type /login');
process.stdout.on('resize',()=>console.log('Size: '+process.stdout.columns+'x'+process.stdout.rows));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 console.log('Pi received: '+line);
 if(line==='/exit') process.exit(0);
});`,
    { mode: 0o700 },
  );
  const { piLoginDriver } = await import("./pi-login-driver.ts");
  let changed = false;
  const sessions = new ProviderLoginSessions({
    now: () => 1,
    id: () => "pi-other",
    schedule: () => () => {},
    prepare: async (_target, action, _signal, owner) => ({
      ...piLoginDriver({
        command,
        version: "1.1.0",
        cwd: f.dataDir,
        env: f.env,
        action,
        openTerminal: (launch) => f.management.openLoginTerminal(owner, launch),
      }),
      changed: async () => {
        changed = true;
      },
    }),
  });
  const server = await fixture({ providerLogin: sessions, accountManagement: f.management });
  try {
    const client = await server.connect();
    await client.next();
    client.send({ type: "provider.login.start", requestId: "start", provider: "pi" });
    await next(client, (m) => m.type === "provider.login.progress" && !!m.progress.choices);
    client.send({
      type: "provider.login.input",
      requestId: "choose",
      session: "pi-other",
      input: { choice: "other" },
    });
    const opened = await next(
      client,
      (m) => m.type === "provider.login.progress" && !!m.progress.manual?.terminalId,
    );
    if (opened.type !== "provider.login.progress" || !opened.progress.manual?.terminalId)
      throw Error("Missing terminal");
    expect(opened.progress.state).toBe("awaiting_input");
    const terminalId = opened.progress.manual.terminalId;
    client.send({
      type: "terminal.request",
      requestId: "subscribe",
      operation: { op: "subscribe", terminalId, subscriptionId: "pi", fromOffset: 0 },
    });
    await next(
      client,
      (m) =>
        m.type === "terminal.output" &&
        m.event.type === "data" &&
        m.event.data.includes("Pi ready"),
    );
    client.send({
      type: "terminal.request",
      requestId: "input",
      operation: { op: "write", terminalId, data: "/login\n" },
    });
    await next(
      client,
      (m) =>
        m.type === "terminal.output" &&
        m.event.type === "data" &&
        m.event.data.includes("Pi received: /login"),
    );
    client.send({
      type: "terminal.request",
      requestId: "resize",
      operation: { op: "resize", terminalId, cols: 92, rows: 17 },
    });
    await next(
      client,
      (m) =>
        m.type === "terminal.output" &&
        m.event.type === "data" &&
        m.event.data.includes("Size: 92x17"),
    );
    expect(changed).toBe(false);
    client.send({
      type: "terminal.request",
      requestId: "exit",
      operation: { op: "write", terminalId, data: "/exit\n" },
    });
    expect(
      await next(
        client,
        (m) => m.type === "provider.login.progress" && m.progress.state === "succeeded",
      ),
    ).toMatchObject({ progress: { state: "succeeded" } });
    expect(changed).toBe(true);
    client.send({
      type: "terminal.request",
      requestId: "replay",
      operation: { op: "subscribe", terminalId, subscriptionId: "replay", fromOffset: 0 },
    });
    expect(
      await next(client, (m) => m.type === "terminal.result" && m.requestId === "replay"),
    ).toMatchObject({ ok: false, error: "forbidden" });
  } finally {
    await server.close();
    await sessions.close();
    await f.close();
  }
});

test("a CLI that cannot start returns a terminal failure instead of acknowledging a blank session", async () => {
  const f = await harness(false, {
    terminal: {
      dependencies: {
        backendFactory() {
          throw new Error("Synthetic PTY spawn failure");
        },
      },
    },
  });
  try {
    const client = await f.connect();
    await client.next();
    const terminal = f.management.openLoginTerminal("device", {
      shell: join(f.bin, "missing-pi"),
      args: [],
      env: f.env,
      cwd: join(f.dataDir, "missing-directory"),
      cols: 80,
      rows: 24,
      name: "Pi sign-in",
    });
    client.send({
      type: "terminal.request",
      requestId: "start",
      operation: {
        op: "subscribe",
        terminalId: terminal.id,
        subscriptionId: "missing",
        fromOffset: 0,
      },
    });
    expect(
      await next(client, (m) => m.type === "terminal.result" && m.requestId === "start"),
    ).toMatchObject({ ok: false, error: "terminal_failed" });
    expect(await terminal.exited).toBe(false);
  } finally {
    await f.close();
  }
});
