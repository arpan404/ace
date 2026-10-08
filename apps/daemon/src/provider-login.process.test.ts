import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { nodeBinary } from "@ace/provider-kit/testing";
import { ProviderLoginSessions } from "@ace/accounts";
import type { ProviderLoginProgress, ProviderKind } from "@ace/protocol";
import { TerminalManager, createPosixBackendFactory } from "@ace/terminal";
import { cliLoginDriver } from "./provider-login-driver.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const transcripts = z
  .record(
    z.string(),
    z.object({ version: z.string(), help: z.string(), lines: z.array(z.string()) }),
  )
  .parse(
    JSON.parse(
      await readFile(
        new URL("./__fixtures__/provider-login/transcripts.json", import.meta.url),
        "utf8",
      ),
    ),
  );
async function harness(provider: Exclude<ProviderKind, "cursor">, source?: string) {
  const root = await mkdtemp(join(tmpdir(), "ace-login-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const transcript = transcripts[provider];
  const command = await nodeBinary(
    bin,
    "login",
    source ??
      `
    const fs = require('node:fs');
    console.log(${JSON.stringify(transcript?.lines.join("\n") ?? "")});
    console.log('sk-syntheticSecretNeverForwarded0123456789');
    console.log('https://github.com/login/device?access_token=ghp_SYNTHETIC0123456789');
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      fs.writeFileSync(process.env.HOME + '/completed', JSON.stringify({line,args:process.argv.slice(2)})); process.exit(0);
    });
  `,
  );
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: { backendFactory: createPosixBackendFactory(undefined, root) },
  });
  cleanups.push(() => manager.closeAll());
  let expire: (() => void) | undefined;
  const sessions = new ProviderLoginSessions({
    now: () => 1000,
    id: () => "login-one",
    schedule(callback) {
      expire = callback;
      return () => {};
    },
    prepare: async (_target, action) =>
      cliLoginDriver({
        provider,
        action,
        command,
        version: transcript?.version ?? "0.85.1",
        help: transcript?.help ?? "",
        cwd: root,
        env: { HOME: root, PATH: bin },
        manager,
      }),
  });
  cleanups.push(() => sessions.close());
  const events: ProviderLoginProgress[] = [];
  const waiters = new Map<
    ProviderLoginProgress["state"],
    ((progress: ProviderLoginProgress) => void)[]
  >();
  sessions.listen((_owner, progress) => {
    events.push(progress);
    for (const resolve of waiters.get(progress.state) ?? []) resolve(progress);
    waiters.delete(progress.state);
  });
  const wait = (state: ProviderLoginProgress["state"]) => {
    const event = events.findLast((entry) => entry.state === state);
    return event
      ? Promise.resolve(event)
      : new Promise<ProviderLoginProgress>((resolve) => {
          waiters.set(state, [...(waiters.get(state) ?? []), resolve]);
        });
  };
  const start = () =>
    sessions.handle("phone", { type: "provider.login.start", requestId: "start", provider });
  return { root, sessions, start, wait, events, expire: () => expire?.() };
}

test.each(["codex", "claude", "opencode"] as const)(
  "%s native login relays safe challenges and Enter input without output history",
  async (provider) => {
    const f = await harness(provider);
    expect(await f.start()).toMatchObject({
      result: { ok: true, progress: { state: "starting", session: "login-one" } },
    });
    if (provider === "opencode") {
      await f.wait("awaiting_input");
      expect(
        await f.sessions.handle("phone", {
          type: "provider.login.input",
          requestId: "choose",
          session: "login-one",
          input: { choice: "github-copilot" },
        }),
      ).toMatchObject({ result: { ok: true } });
    }
    const prompt = await f.wait("awaiting_input");
    // The initial upstream selector is followed by the CLI's Enter prompt.
    const enter =
      prompt.prompt === "Press Enter to continue."
        ? prompt
        : await new Promise<ProviderLoginProgress>((resolve) => {
            const stop = f.sessions.listen((_owner, progress) => {
              if (progress.prompt === "Press Enter to continue.") {
                stop();
                resolve(progress);
              }
            });
          });
    expect(enter.url).toMatch(/^https:\/\//);
    if (provider === "codex" || provider === "opencode")
      expect(enter.userCode).toMatch(/^[A-Z0-9]+-[A-Z0-9]+$/);
    await f.sessions.handle("phone", {
      type: "provider.login.input",
      requestId: "enter",
      session: "login-one",
      input: { confirm: true },
    });
    await f.wait("succeeded");
    expect(JSON.parse(await readFile(join(f.root, "completed"), "utf8"))).toMatchObject({
      line: "",
      args:
        provider === "codex"
          ? ["login", "--device-auth"]
          : provider === "claude"
            ? ["auth", "login", "--claudeai"]
            : provider === "opencode"
              ? [
                  "auth",
                  "login",
                  "--provider",
                  "github-copilot",
                  "--method",
                  "Login with GitHub Copilot",
                ]
              : ["login"],
    });
    expect(JSON.stringify(f.events)).not.toMatch(/syntheticSecret|access_token|ghp_/);
    expect(await f.start()).toMatchObject({ result: { progress: { state: "succeeded" } } });
  },
);

test("split browser links and standalone device codes produce complete safe challenges", async () => {
  const f = await harness(
    "codex",
    `process.stdout.write('Open https://auth.openai.com/codex/', () => {
      setImmediate(() => process.stdout.write('device\\nEnter code:\\nABCD-12345\\nPress Enter to continue.'));
    });
    require('node:readline').createInterface({input:process.stdin}).on('line', () => process.exit(0));`,
  );
  await f.start();
  const progress = await f.wait("awaiting_input");
  expect(progress).toMatchObject({
    url: "https://auth.openai.com/codex/device",
    userCode: "ABCD-12345",
    prompt: "Press Enter to continue.",
  });
  await f.sessions.handle("phone", {
    type: "provider.login.input",
    requestId: "enter",
    session: "login-one",
    input: { value: "enter" },
  });
  await f.wait("succeeded");
});

test("excessive private CLI output stops the process and returns terminal instructions", async () => {
  const f = await harness(
    "codex",
    `process.stdout.write('sk-private' + 'x'.repeat(300000)); process.stdin.resume();`,
  );
  await f.start();
  expect(await f.wait("failed")).toMatchObject({ manual: { command: "codex login" } });
  expect(JSON.stringify(f.events)).not.toContain("sk-private");
});

test("paste-code prompts stop the CLI and return terminal instructions without accepting arbitrary input", async () => {
  const f = await harness(
    "claude",
    "console.log('Paste authorization code:'); setInterval(()=>{},1000);",
  );
  await f.start();
  expect(await f.wait("failed")).toMatchObject({ manual: { command: "claude auth login" } });
  await expect(
    f.sessions.handle("phone", {
      type: "provider.login.input",
      requestId: "key",
      session: "login-one",
      input: { value: "sk-DO-NOT-ACCEPT" },
    }),
  ).rejects.toThrow();
});

test.each(["cancel", "timeout"])(
  "%s drains the CLI and its background process before publishing a terminal state",
  async (mode) => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const connected = once(server, "connection");
    const f = await harness(
      "codex",
      `
    for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal,()=>{});
    require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`for (const s of ['SIGTERM','SIGINT','SIGHUP']) process.on(s,()=>{}); require('node:net').connect(${address.port},'127.0.0.1'); setInterval(()=>{},1000);`)}],{stdio:'ignore'});
    console.log('Open https://auth.openai.com/codex/device'); setInterval(()=>{},1000);
  `,
    );
    await f.start();
    const [socket] = await connected;
    const closed = once(socket, "close");
    await f.wait("awaiting_browser");
    expect(
      await f.sessions.handle("other", {
        type: "provider.login.poll",
        requestId: "steal",
        session: "login-one",
      }),
    ).toMatchObject({ result: { error: "forbidden" } });
    expect(
      await f.sessions.handle("phone", {
        type: "provider.login.start",
        requestId: "second",
        provider: "codex",
        instance: "codex-cli-default",
      }),
    ).toMatchObject({ result: { error: "busy" } });
    if (mode === "cancel")
      await f.sessions.handle("phone", {
        type: "provider.login.cancel",
        requestId: "cancel",
        session: "login-one",
      });
    else f.expire();
    const terminal = await f.wait(mode === "cancel" ? "cancelled" : "failed");
    await closed;
    expect(socket.destroyed).toBe(true);
    expect(terminal.url).toBeUndefined();
    expect(f.events.some((event) => event.state === "succeeded")).toBe(false);
  },
);
