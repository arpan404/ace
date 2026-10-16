import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProviderLoginSessions } from "@ace/accounts";
import { nodeBinary } from "@ace/provider-kit/testing";
import { TerminalManager, createPosixBackendFactory } from "@ace/terminal";
import type { ProviderLoginProgress } from "@ace/protocol";
import { cliLoginDriver } from "./provider-login-driver.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

async function setup(version = "2.0.30", action: "login" | "logout" = "login") {
  const root = await mkdtemp(join(tmpdir(), "ace-opencode-login-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const command = await nodeBinary(
    root,
    "opencode",
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.includes('--provider') || args.includes('--method') || !args.includes('--standalone')) process.exit(64);
    fs.writeFileSync(process.env.XDG_DATA_HOME + '/launch.json', JSON.stringify({args,cwd:process.cwd()}));
    console.log('native-private-key-prompt');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      fs.writeFileSync(process.env.XDG_DATA_HOME + '/credential', line);
      process.exit(line === 'decline' ? 1 : 0);
    });
  `,
  );
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: { backendFactory: createPosixBackendFactory(undefined, root) },
  });
  cleanups.push(() => manager.closeAll());
  let live: ReturnType<TerminalManager["openLiveTerminal"]> | undefined;
  const ready = Promise.withResolvers<void>();
  const events: ProviderLoginProgress[] = [];
  const sessions = new ProviderLoginSessions({
    now: () => 1,
    id: () => "v2-login",
    schedule: () => () => {},
    prepare: async () =>
      cliLoginDriver({
        provider: "opencode",
        action,
        version,
        command,
        help: "auth login --standalone",
        cwd: root,
        env: { XDG_DATA_HOME: root, XDG_CONFIG_HOME: root },
        manager,
        openTerminal(launch) {
          live = manager.openLiveTerminal(launch, (event) => {
            if (event.type === "data" && event.data.includes("native-private-key-prompt"))
              ready.resolve();
          });
          const terminal = live;
          return {
            id: "native-v2-terminal",
            exited: terminal.exited.then((exit) => exit.code === 0),
            stop: () => manager.releaseLive(terminal),
          };
        },
      }),
  });
  cleanups.push(() => sessions.close());
  sessions.listen((_owner, progress) => events.push(progress));
  const start = () =>
    sessions.handle(
      "owner",
      action === "login"
        ? { type: "provider.login.start", provider: "opencode", requestId: "start" }
        : { type: "provider.logout", provider: "opencode", requestId: "start" },
    );
  const choose = (id: string) =>
    sessions.handle("owner", {
      type: "provider.login.input",
      session: "v2-login",
      requestId: "choose",
      input: { choice: id },
    });
  return {
    root,
    events,
    sessions,
    start,
    choose,
    ready: ready.promise,
    write: (text: string) => live?.write(text),
  };
}

test.each([
  "github-copilot",
  "openai",
  "anthropic",
  "openrouter",
  "opencode-go",
  "opencode",
  "other",
])(
  "%s opens v2 sign-in inside ace in the selected profile, with no failure or second terminal choice",
  async (upstream) => {
    const f = await setup();
    await f.start();
    await expect.poll(() => f.events.at(-1)?.choices?.length).toBe(7);
    await f.choose(upstream);
    await f.ready;
    expect(f.events.at(-1)).toMatchObject({
      state: "awaiting_input",
      manual: { terminalId: "native-v2-terminal" },
    });
    expect(f.events.some((event) => event.state === "failed")).toBe(false);
    expect(JSON.parse(await readFile(join(f.root, "launch.json"), "utf8"))).toEqual({
      args: ["auth", "login", "--standalone", ...(upstream === "other" ? [] : [upstream])],
      cwd: f.root,
    });
    const key = "private-synthetic-key";
    f.write(key + "\r");
    expect((await f.sessions.completed("owner", "v2-login")).state).toBe("succeeded");
    expect(await readFile(join(f.root, "credential"), "utf8")).toBe(key);
    expect(JSON.stringify(f.events)).not.toMatch(/private-synthetic-key|native-private-key-prompt/);
  },
);

test("v1 cannot start a sign-in terminal", async () => {
  const f = await setup("1.19.1");
  await f.start();
  expect(await f.sessions.completed("owner", "v2-login")).toMatchObject({
    state: "failed",
    message: expect.stringContaining("Install OpenCode v2"),
  });
  await expect(readFile(join(f.root, "launch.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("cancelling native v2 sign-in ends the terminal and rejects later input", async () => {
  const f = await setup();
  await f.start();
  await expect.poll(() => f.events.at(-1)?.choices?.length).toBe(7);
  await f.choose("openai");
  await f.ready;
  await f.sessions.handle("owner", {
    type: "provider.login.cancel",
    session: "v2-login",
    requestId: "cancel",
  });
  expect((await f.sessions.completed("owner", "v2-login")).state).toBe("cancelled");
  expect(await f.choose("anthropic")).toMatchObject({ result: { ok: false } });
});

test("a declined v2 native login stays failed", async () => {
  const f = await setup();
  await f.start();
  await expect.poll(() => f.events.at(-1)?.choices?.length).toBe(7);
  await f.choose("openai");
  await f.ready;
  f.write("decline\r");
  expect((await f.sessions.completed("owner", "v2-login")).state).toBe("failed");
});

test("disconnecting an OpenCode service uses the v2 account picker in the same terminal", async () => {
  const f = await setup("2.0.30", "logout");
  await f.start();
  await expect.poll(() => f.events.at(-1)?.choices?.length).toBe(7);
  await f.choose("opencode-go");
  await f.ready;
  expect(JSON.parse(await readFile(join(f.root, "launch.json"), "utf8"))).toMatchObject({
    args: ["auth", "logout", "--standalone", "opencode-go"],
  });
  f.write("disconnect\r");
  expect((await f.sessions.completed("owner", "v2-login")).state).toBe("succeeded");
});
