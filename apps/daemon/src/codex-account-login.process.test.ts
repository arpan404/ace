import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProviderLoginSessions } from "@ace/accounts";
import { openCodexAccount } from "@ace/adapter-codex/account-login";
import { nodeBinary } from "@ace/provider-kit/testing";
import { TerminalManager, createPosixBackendFactory } from "@ace/terminal";
import type { ProviderLoginProgress } from "@ace/protocol";
import { cliLoginDriver } from "./provider-login-driver.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const browserPage =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_fixture&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid&state=fixture&code_challenge=fixture&code_challenge_method=S256";

/** Codex's app-server account API, as codex-cli 0.163 answers it. No token ever exists. */
const fakeCodex = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\\n');
if (args[0] === 'app-server') {
  const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    log({ method: request.method, params: request.params });
    const reply = (result) => write({ id: request.id, result });
    if (request.method === 'initialize') return reply({});
    if (request.method === 'account/login/start') {
      if (process.env.FAKE_NO_LOGIN) return write({ id: request.id, error: { code: -32601, message: 'unknown method' } });
      if (request.params.type === 'chatgptDeviceCode') {
        if (process.env.FAKE_DEVICE === 'refused')
          return write({ id: request.id, error: { code: -32603, message: 'device code login is not enabled' } });
        reply({ type: 'chatgptDeviceCode', loginId: 'device-login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345' });
        if (process.env.FAKE_DEVICE === 'hold') return;
        const success = process.env.FAKE_DEVICE !== 'fails';
        return setTimeout(() => write({ method: 'account/login/completed', params: { loginId: 'device-login', success, error: success ? null : 'disabled' } }), 50);
      }
      reply({ type: 'chatgpt', loginId: 'browser-login', authUrl: ${JSON.stringify(browserPage)} });
      return setTimeout(() => write({ method: 'account/login/completed', params: { loginId: 'browser-login', success: true } }), 50);
    }
    if (request.method === 'account/login/cancel') return reply({});
    if (request.method === 'account/read')
      return reply({ account: { type: 'chatgpt', email: 'person@example.com', planType: 'plus' }, requiresOpenaiAuth: false });
    write({ id: request.id, error: { code: -32601, message: 'unknown method' } });
  });
} else {
  log({ terminal: args });
  console.log('Open https://auth.openai.com/codex/device');
  console.log('Enter code: WXYZ-98765');
  process.exit(0);
}
`;

async function setup(env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "ace-codex-account-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const command = await nodeBinary(root, "codex", fakeCodex);
  const log = join(root, "codex.log");
  const processEnv = { HOME: root, FAKE_LOG: log, ...env };
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: { backendFactory: createPosixBackendFactory(undefined, root) },
  });
  cleanups.push(() => manager.closeAll());
  const events: ProviderLoginProgress[] = [];
  const labels: string[] = [];
  const sessions = new ProviderLoginSessions({
    now: () => 1,
    id: () => "codex-login",
    schedule: () => () => {},
    prepare: async () =>
      cliLoginDriver({
        provider: "codex",
        action: "login",
        version: "0.163.0",
        command,
        help: "login logout --device-auth --with-api-key",
        cwd: root,
        env: processEnv,
        manager,
        codexAccount: (signal) =>
          openCodexAccount({ executable: command, env: processEnv, cwd: root, signal }),
        onCodexAccount: (label) => labels.push(label),
      }),
  });
  cleanups.push(() => sessions.close());
  sessions.listen((_owner, progress) => events.push(progress));
  await sessions.handle("owner", {
    type: "provider.login.start",
    provider: "codex",
    requestId: "start",
  });
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line) as { method?: string; params?: unknown; terminal?: string[] },
      );
  return {
    events,
    labels,
    calls,
    sessions,
    done: () => sessions.completed("owner", "codex-login"),
  };
}

test("Codex signs in with a device code from its app-server, labelled with the account's email", async () => {
  const f = await setup();
  expect((await f.done()).state).toBe("succeeded");
  expect(f.events).toContainEqual(
    expect.objectContaining({
      state: "awaiting_code_entry",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-12345",
    }),
  );
  expect(f.labels).toEqual(["person@example.com"]);
  const calls = await f.calls();
  expect(calls.map((call) => call.method ?? "terminal")).toEqual([
    "initialize",
    "account/login/start",
    "account/read",
  ]);
  expect(calls[1]?.params).toEqual({ type: "chatgptDeviceCode" });
});

test.each(["refused", "fails"])(
  "when Codex %s a device code, its browser sign-in follows",
  async (device) => {
    const f = await setup({ FAKE_DEVICE: device });
    expect((await f.done()).state).toBe("succeeded");
    expect(f.events).toContainEqual(
      expect.objectContaining({ state: "awaiting_browser", url: browserPage }),
    );
    const starts = (await f.calls()).filter((call) => call.method === "account/login/start");
    expect(starts.map((call) => call.params)).toEqual([
      { type: "chatgptDeviceCode" },
      { type: "chatgpt" },
    ]);
    expect(f.labels).toEqual(["person@example.com"]);
  },
);

test("cancelling a Codex sign-in cancels it in Codex", async () => {
  const f = await setup({ FAKE_DEVICE: "hold" });
  await expect.poll(() => f.events.at(-1)?.userCode).toBe("ABCD-12345");
  await f.sessions.handle("owner", {
    type: "provider.login.cancel",
    session: "codex-login",
    requestId: "cancel",
  });
  expect((await f.done()).state).toBe("cancelled");
  await expect
    .poll(async () => (await f.calls()).find((call) => call.method === "account/login/cancel"))
    .toMatchObject({ params: { loginId: "device-login" } });
});

test("a Codex whose app-server can't sign in still signs in through its own login", async () => {
  const f = await setup({ FAKE_NO_LOGIN: "1" });
  expect((await f.done()).state).toBe("succeeded");
  expect((await f.calls()).filter((call) => call.terminal)).toEqual([
    { terminal: ["login", "--device-auth"] },
  ]);
  expect(f.labels).toEqual([]);
});
