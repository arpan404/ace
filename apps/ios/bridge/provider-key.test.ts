import "./test-host.ts";
import type { ClientCore } from "@ace/client";
import { authenticatedChannel, ephemeralRelayKeys } from "@ace/client/devices";
import type { FakeDaemon } from "@ace/fake-daemon";
import { afterEach, expect, test } from "vitest";
import { ApiKeyScreenRequest, directLinkProblem, handOverApiKey } from "./provider-key.ts";
import { answerSettingsManage, SettingsManageRequest } from "./settings-manage.ts";
import { settingsFixture } from "./settings-fixture.ts";

/*
 * Adding an account with a pasted API key, over the SDK's real authenticated channel to an
 * in-process fake daemon at the socket boundary: where the key travels, what comes back, and
 * what happens when the daemon or the link says no.
 */

const key = "sk-proj-PHONEKEY0123456789abcdef";
let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

// Bridge answers are untyped JSON for Swift; the tests read them as such.
// oxlint-disable-next-line typescript/no-explicit-any
type Answer = Record<string, any>;

/** Every frame the phone wrote on one socket, with the hello it opened with. */
interface Socket {
  frames: string[];
  hello(): Answer;
}

async function open(options: { relayed?: boolean; fromDaemon?: (frame: Answer) => void } = {}) {
  const fixture = await settingsFixture();
  client = fixture.owner;
  const sockets: Socket[] = [];
  const channel = () =>
    authenticatedChannel(
      {
        target: { kind: "local", url: "wss://native.invalid" },
        expectedHostId: "ios-test-host",
        deviceId: "ios-settings-test",
        credential: async () => ({ token: "ios-test-token" }),
        socket: () => fakeSocket(fixture.daemon, sockets, options.fromDaemon),
        keys: ephemeralRelayKeys,
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      "provider_auth",
    );
  const deps = {
    channel,
    relayed: () => options.relayed ?? true,
    id: () => crypto.randomUUID(),
    schedule: (delayMs: number, callback: () => void) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  const add = async (
    fields: Partial<ApiKeyScreenRequest> = {},
    signal = new AbortController().signal,
  ) => {
    const request = ApiKeyScreenRequest.parse({
      type: "accounts.screen.key",
      provider: "codex",
      label: "Work",
      apiKey: key,
      ...fields,
    });
    const answer = (await handOverApiKey(deps, request, signal)) as Answer;
    return { answer, request };
  };
  const screen = async (provider: "codex" | "claude", relayed = options.relayed ?? true) =>
    (
      (await answerSettingsManage(
        fixture.owner,
        SettingsManageRequest.parse({ type: "accounts.screen", provider }),
        new AbortController().signal,
        relayed,
      )) as Answer
    ).screen;
  return { ...fixture, sockets, add, screen };
}

/** A socket straight into the fake daemon, as Swift's relay socket is to the real one. */
function fakeSocket(daemon: FakeDaemon, sockets: Socket[], fromDaemon?: (frame: Answer) => void) {
  const listeners = new Map<string, ((event?: { data: unknown; code?: number }) => void)[]>();
  const emit = (type: string, event?: { data: unknown; code?: number }) =>
    queueMicrotask(() => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    });
  const record: Socket = {
    frames: [],
    hello: () => JSON.parse(record.frames[0] ?? "null") as Answer,
  };
  sockets.push(record);
  const connection = daemon.connect({
    send: (text) => {
      fromDaemon?.(JSON.parse(text) as Answer);
      emit("message", { data: text });
    },
    close: (code) => emit("close", { data: null, code }),
  });
  emit("open");
  return {
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    addEventListener(type: string, listener: (event?: { data: unknown; code?: number }) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    send(data: string | Uint8Array) {
      if (typeof data !== "string") throw new Error("Provider auth sends only JSON");
      record.frames.push(data);
      queueMicrotask(() => connection.receive(data));
    },
    close() {
      connection.close();
    },
  };
}

test("a pasted key adds the account through its own uncompressed provider_auth channel, and only there", async () => {
  const { add, sockets, screen } = await open();
  const { answer, request } = await add();
  expect(answer).toMatchObject({ ok: true });
  expect(answer.instance).toEqual(expect.any(String));
  // One channel for one hand-off, said to be provider_auth, never deflated.
  expect(sockets).toHaveLength(1);
  expect(sockets[0]?.hello()).toMatchObject({ type: "hello", channel: "provider_auth" });
  expect(sockets[0]?.hello().compression).toBeUndefined();
  // The key crossed in exactly one frame, the dedicated message, and nowhere else.
  const carrying = sockets[0]?.frames.filter((frame) => frame.includes(key)) ?? [];
  expect(carrying.map((frame) => (JSON.parse(frame) as Answer).type)).toEqual([
    "provider.login.apiKey",
  ]);
  // Nothing the phone keeps holds it: not the answer for Swift, not the request it was given.
  expect(JSON.stringify(answer)).not.toContain(key);
  expect(request.apiKey).toBe("");
  // The Accounts page, read again over the main socket, lists the new key account.
  const accounts = (await screen("codex")).accounts as Answer[];
  expect(accounts.find((row) => row.id === answer.instance)).toMatchObject({
    label: "Work",
    method: "API key",
  });
});

test("a key the provider declines says the daemon's fixed words and adds no account", async () => {
  const { add, daemon, screen } = await open();
  const before = ((await screen("codex")).accounts as Answer[]).length;
  daemon.services.providerLogin.scenarios.codex = "failure";
  const { answer } = await add();
  expect(answer).toEqual({ ok: false, problem: "The provider declined sign-in. Try again." });
  expect(JSON.stringify(answer)).not.toContain(key);
  expect((await screen("codex")).accounts).toHaveLength(before);
});

test("on a direct link the key never leaves the phone and the page says where keys go", async () => {
  const { add, sockets, screen } = await open({ relayed: false });
  const { answer, request } = await add();
  expect(answer).toEqual({ ok: false, problem: directLinkProblem });
  expect(sockets).toHaveLength(0);
  expect(request.apiKey).toBe("");
  const codex = await screen("codex");
  expect(codex.keyWays).toEqual([]);
  expect(codex.apiKey).toBe(directLinkProblem);
});

test("a paste that isn't one key token is refused before any channel opens", async () => {
  const { add, sockets } = await open();
  const { answer } = await add({ apiKey: "sk-one sk-two" });
  expect(answer).toEqual({ ok: false, problem: "Paste a valid API key and try again." });
  expect(sockets).toHaveLength(0);
});

test("a provider the daemon says takes no key offers none, and a forced add is refused in words", async () => {
  const { add, screen } = await open();
  const claude = await screen("claude");
  expect(claude.keyWays).toEqual([]);
  expect(claude.apiKey).toBeNull();
  const codex = await screen("codex");
  expect(codex.keyWays).toMatchObject([{ id: "api_key", label: "API key", upstream: null }]);
  expect(codex.apiKey).toBeNull();
  const { answer } = await add({ provider: "claude" });
  expect(answer).toEqual({ ok: false, problem: "Claude Code can't take an API key from ace." });
});

test("a sheet that goes while the CLI gets ready never sends the key, and no account is added", async () => {
  const leaving = new AbortController();
  const { add, sockets, screen } = await open({
    // The person swipes the sheet away just as the CLI asks for the key.
    fromDaemon: (frame) => {
      if (frame.type === "provider.login.progress" && frame.progress.state === "awaiting_api_key")
        leaving.abort();
    },
  });
  const before = ((await screen("codex")).accounts as Answer[]).length;
  const { answer } = await add({}, leaving.signal);
  expect(answer.ok).toBe(false);
  const sent = sockets.flatMap((socket) => socket.frames);
  expect(sent.some((frame) => frame.includes(key))).toBe(false);
  expect(sent.map((frame) => (JSON.parse(frame) as Answer).type)).not.toContain(
    "provider.login.apiKey",
  );
  // The staged account never joins the list.
  expect((await screen("codex")).accounts).toHaveLength(before);
});
