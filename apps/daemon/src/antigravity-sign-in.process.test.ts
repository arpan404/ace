import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  AccountService,
  antigravityIdentity,
  createAntigravityInstance,
  openRegistry,
  ProviderLoginSessions,
} from "@ace/accounts";
import { createLogger } from "@ace/diagnostics";
import type { ProviderLoginProgress, ProviderLoginRequest } from "@ace/protocol";
import { createManagedHome } from "./account-homes.ts";
import { readConfig } from "./config.ts";
import { prepareAgentLogin } from "./services/provider-login-agent.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { Store } from "./store.ts";

/**
 * A scripted Antigravity ACP server on PATH that signs in the way the real one does: it advertises
 * its four methods, and a browser method opens Google's page through `$BROWSER` with a
 * `redirect_uri` back to a one-shot listener on 127.0.0.1, answering `authenticate` only once
 * that listener has been called with a code. Agent Platform needs `gcp` in its settings. It
 * records what each `authenticate` saw. No provider, browser or credential is involved.
 */
async function antigravity() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-antigravity-sign-in-")));
  const bin = join(home, "bin");
  const seen = join(home, "seen.jsonl");
  await mkdir(bin);
  await writeFile(
    join(bin, "agy_acp_server"),
    `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('agy_acp_server 1.4.1'); process.exit(0); }
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
const fail = (id, message) => console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message } }));
const settings = () => {
  const home = process.env.GEMINI_HOME || join(process.env.HOME, '.gemini');
  try { return JSON.parse(readFileSync(join(home, 'antigravity-acp', 'settings.json'), 'utf8')); } catch { return null; }
};
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') return reply(request.id, {
    protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.4.1' },
    authMethods: [
      { id: 'oauth-personal', name: 'Log in with Google' },
      { id: 'oauth-business', name: 'Log in with Gemini Enterprise' },
      { id: 'gemini-api-key', name: 'Gemini API key' },
      { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform',
        description: 'Use Agent Platform with Application Default Credentials or an API key' },
    ] });
  if (request.method !== 'authenticate') return reply(request.id, {});
  const method = request.params.methodId;
  const record = (extra) => appendFileSync(${JSON.stringify(seen)}, JSON.stringify({
    method, settings: settings(), project: process.env.GOOGLE_CLOUD_PROJECT ?? null, ...extra }) + '\\n');
  if (method === 'agent-platform') {
    record({});
    const gcp = settings()?.gcp;
    return gcp?.project && gcp?.location ? reply(request.id, {}) : fail(request.id, 'gcp unset');
  }
  const server = http.createServer((incoming, outgoing) => {
    record({ returned: incoming.url, host: incoming.headers.host });
    if (method === 'oauth-business') {
      outgoing.writeHead(302, { location: 'http://127.0.0.1:1/license' });
      outgoing.end();
    } else outgoing.end('<h1>Authentication successful</h1>');
    server.close();
    if (new URL(incoming.url, 'http://x').searchParams.get('code') === 'one-time') reply(request.id, {});
    else fail(request.id, 'denied');
  });
  server.listen(0, '127.0.0.1', () => {
    const back = 'http://127.0.0.1:' + server.address().port + '/';
    spawnSync(process.env.BROWSER, ['https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&response_type=code&state=s&redirect_uri=' + encodeURIComponent(back)]);
  });
});
`,
    { mode: 0o700 },
  );
  // A key-bearing variable in the person's environment; added accounts must never see it.
  const env = { HOME: home, PATH: bin, GOOGLE_CLOUD_PROJECT: "persons-own-project" };
  const resources = new Resources();
  const registry = await openRegistry(join(home, "accounts.sqlite"), home);
  resources.own(() => registry.close());
  await registry.register(createAntigravityInstance(home));
  const store = new Store(join(home, "events.sqlite"));
  resources.own(() => store.close());
  const log = createLogger({
    now: () => 1000,
    redact: (value) => value,
    sink: { write: async () => {}, close: async () => {} },
  });
  let id = 0;
  const accounts = new AccountService({ registry, env, now: () => 1000, timeZone: "UTC" });
  const context: ServiceContext = {
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0" }, home),
    options: { accounts: { env }, providerStatus: { env } },
    services: { accountRegistry: registry, accounts },
    resources,
    store,
    now: () => 1000,
    id: () => String(++id),
    log,
    signal: new AbortController().signal,
    onListen: [],
  };
  let prepared = 0;
  const sessions = new ProviderLoginSessions({
    now: () => 1000,
    id: () => `login-${++id}`,
    schedule: () => () => {},
    prepare: (target, action, signal, owner) => {
      prepared++;
      return prepareAgentLogin(
        context,
        {
          provider: "antigravity",
          ...(target.instance ? { instance: target.instance } : {}),
          ...(target.signIn ? { signIn: target.signIn } : {}),
        },
        action,
        signal,
        owner,
      );
    },
  });
  const pushed: ProviderLoginProgress[] = [];
  sessions.listen((_owner, progress) => pushed.push(progress));
  return {
    home,
    registry,
    sessions,
    pushed,
    prepared: () => prepared,
    async add(label: string) {
      const instance = await createManagedHome(home, `account-${++id}`, "antigravity", label);
      await registry.register(instance);
      return instance;
    },
    async start(extra: Partial<Extract<ProviderLoginRequest, { type: "provider.login.start" }>>) {
      const result = await sessions.handle("device", {
        type: "provider.login.start",
        requestId: `request-${++id}`,
        provider: "antigravity",
        ...extra,
      });
      if (!result.result.ok) throw new Error(`Login refused: ${result.result.error}`);
      return result.result.progress.session;
    },
    /** The sign-in's progress once a snapshot matches. */
    async until(session: string, match: (progress: ProviderLoginProgress) => boolean) {
      for (let attempt = 0; attempt < 400; attempt++) {
        const found = pushed.find((progress) => progress.session === session && match(progress));
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Sign-in never reached that step");
    },
    paste(session: string, returnUrl: string, owner = "device") {
      return sessions.handle(owner, {
        type: "provider.login.input",
        requestId: `request-${++id}`,
        session,
        input: { returnUrl },
      });
    },
    async seen() {
      const text = await readFile(seen, "utf8").catch(() => "");
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              method: string;
              settings: Record<string, unknown> | null;
              project: string | null;
              returned?: string;
            },
        );
    },
    async close() {
      await sessions.close();
      await resources.close();
      await log.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** The port of the agent's listener, from the page it relayed. */
function listenerPort(progress: ProviderLoginProgress): string {
  const back = new URL(new URL(progress.url ?? "").searchParams.get("redirect_uri") ?? "");
  return back.port;
}

test("a Google sign-in finished on another device completes once its return address is pasted back", async () => {
  const f = await antigravity();
  try {
    const session = await f.start({ signIn: { method: "google" } });
    const waiting = await f.until(session, (progress) => progress.returnUrlEntry === true);
    const port = listenerPort(waiting);

    const pasted = `http://localhost:${port}/?state=s&code=one-time&scope=email`;
    const answer = await f.paste(session, pasted);
    expect(answer.result.ok).toBe(true);
    expect(await f.sessions.completed("device", session)).toMatchObject({ state: "succeeded" });
    // The listener on this computer got the return exactly as pasted, on 127.0.0.1.
    expect((await f.seen()).at(-1)).toMatchObject({
      method: "oauth-personal",
      returned: "/?state=s&code=one-time&scope=email",
    });
    // The code never went back out to any client.
    expect(JSON.stringify([...f.pushed, answer])).not.toContain("one-time");
    expect(f.registry.summary(antigravityIdentity.instanceId, 1000)).toMatchObject({
      antigravitySignIn: "google",
    });
    // Once the sign-in has ended, nothing more is forwarded.
    expect((await f.paste(session, pasted)).result).toEqual({ ok: false, error: "invalid_input" });
  } finally {
    await f.close();
  }
});

test("a return address goes only to the device that started the sign-in, and only to its own listener", async () => {
  const f = await antigravity();
  try {
    const session = await f.start({ signIn: { method: "google" } });
    const port = listenerPort(
      await f.until(session, (progress) => progress.returnUrlEntry === true),
    );
    const otherPort = String((Number(port) % 60000) + 1024);

    expect(
      (await f.paste(session, `http://127.0.0.1:${port}/?code=one-time`, "other")).result,
    ).toEqual({ ok: false, error: "forbidden" });
    for (const wrong of [
      `http://127.0.0.1:${otherPort}/?code=one-time`,
      `http://127.0.0.1:${port}/elsewhere?code=one-time`,
    ])
      expect((await f.paste(session, wrong)).result).toEqual({ ok: false, error: "invalid_input" });
    // Not a loopback address at all: refused before it reaches the sign-in.
    await expect(f.paste(session, `http://example.com:${port}/?code=one-time`)).rejects.toThrow();
    expect(await f.seen()).toEqual([]);

    expect((await f.paste(session, `http://127.0.0.1:${port}/?code=one-time`)).result.ok).toBe(
      true,
    );
    expect(await f.sessions.completed("device", session)).toMatchObject({ state: "succeeded" });
  } finally {
    await f.close();
  }
});

test("a callback the agent rejects doesn't count as signed in", async () => {
  const f = await antigravity();
  try {
    const session = await f.start({ signIn: { method: "google" } });
    const port = listenerPort(
      await f.until(session, (progress) => progress.returnUrlEntry === true),
    );
    // The listener answers the page, but the agent's own authenticate fails.
    expect(
      (await f.paste(session, `http://127.0.0.1:${port}/?error=access_denied`)).result.ok,
    ).toBe(true);
    expect(await f.sessions.completed("device", session)).toMatchObject({ state: "failed" });
    expect(f.registry.summary(antigravityIdentity.instanceId, 1000)?.antigravitySignIn).toBe(
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("Gemini Enterprise on an added account writes only its project and location into that account's settings", async () => {
  const f = await antigravity();
  try {
    const work = await f.add("Work");
    const file = join(work.homeDir, "antigravity-acp", "settings.json");
    await mkdir(join(work.homeDir, "antigravity-acp"), { recursive: true });
    await writeFile(file, JSON.stringify({ auth: { type: "oauth-personal" }, gcp: { note: 1 } }));

    const session = await f.start({
      instance: work.id,
      signIn: { method: "enterprise", project: "acme-agents", location: "eu" },
    });
    const port = listenerPort(
      await f.until(session, (progress) => progress.returnUrlEntry === true),
    );
    expect((await f.paste(session, `http://127.0.0.1:${port}/?code=one-time`)).result.ok).toBe(
      true,
    );
    // The agent goes on to its license choice on this computer; the person is told where.
    expect(
      await f.until(
        session,
        (progress) => progress.hint?.includes("choosing your license") ?? false,
      ),
    ).toBeTruthy();
    expect(await f.sessions.completed("device", session)).toMatchObject({ state: "succeeded" });

    const [authenticated] = await f.seen();
    expect(authenticated).toMatchObject({
      method: "oauth-business",
      settings: {
        auth: { type: "oauth-personal" },
        gcp: { note: 1, project: "acme-agents", location: "eu" },
      },
      // The person's own project never reaches an added account.
      project: null,
    });
    // The person's own settings were not touched.
    await expect(
      readFile(join(f.home, ".gemini", "antigravity-acp", "settings.json")),
    ).rejects.toThrow();
    expect(f.registry.summary(work.id, 1000)).toMatchObject({ antigravitySignIn: "enterprise" });
  } finally {
    await f.close();
  }
});

test("an added account whose settings folder links to the person's own never rewrites their settings", async () => {
  const f = await antigravity();
  try {
    const personal = join(f.home, ".gemini", "antigravity-acp");
    await mkdir(personal, { recursive: true });
    const before = JSON.stringify({ auth: { type: "oauth-personal" } });
    await writeFile(join(personal, "settings.json"), before);
    const work = await f.add("Work");
    await symlink(personal, join(work.homeDir, "antigravity-acp"));

    const session = await f.start({
      instance: work.id,
      signIn: { method: "enterprise", project: "acme-agents", location: "eu" },
    });
    expect(await f.sessions.completed("device", session)).toMatchObject({ state: "failed" });
    expect(await readFile(join(personal, "settings.json"), "utf8")).toBe(before);
  } finally {
    await f.close();
  }
});

test("Agent Platform signs in without a browser and the account keeps that method", async () => {
  const f = await antigravity();
  try {
    const work = await f.add("Cloud");
    const session = await f.start({
      instance: work.id,
      signIn: { method: "agent_platform", project: "acme-agents", location: "us-central1" },
    });
    expect(await f.sessions.completed("device", session)).toMatchObject({ state: "succeeded" });
    expect(f.pushed.some((progress) => progress.state === "awaiting_browser")).toBe(false);
    expect(await f.seen()).toEqual([
      {
        method: "agent-platform",
        settings: { gcp: { project: "acme-agents", location: "us-central1" } },
        project: null,
      },
    ]);
    expect(f.registry.summary(work.id, 1000)).toMatchObject({
      antigravitySignIn: "agent_platform",
    });
  } finally {
    await f.close();
  }
});

test("the CLI login's settings are rewritten only when they're plain JSON", async () => {
  const f = await antigravity();
  try {
    const file = join(f.home, ".gemini", "antigravity-acp", "settings.json");
    await mkdir(join(f.home, ".gemini", "antigravity-acp"), { recursive: true });
    const commented = '{\n  // mine\n  "auth": { "type": "oauth-personal" }\n}\n';
    await writeFile(file, commented);
    const session = await f.start({
      signIn: { method: "agent_platform", project: "acme-agents", location: "global" },
    });
    expect(await f.sessions.completed("device", session)).toMatchObject({
      state: "failed",
      message: expect.stringContaining("isn't plain JSON"),
    });
    expect(await readFile(file, "utf8")).toBe(commented);
    expect(await f.seen()).toEqual([]);

    // Plain JSON keeps its other keys; the person's own environment still reaches the CLI login.
    await writeFile(file, JSON.stringify({ auth: { type: "oauth-personal" } }));
    const again = await f.start({
      signIn: { method: "agent_platform", project: "acme-agents", location: "global" },
    });
    expect(await f.sessions.completed("device", again)).toMatchObject({ state: "succeeded" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      auth: { type: "oauth-personal" },
      gcp: { project: "acme-agents", location: "global" },
    });
    expect((await f.seen()).at(-1)).toMatchObject({ project: "persons-own-project" });
  } finally {
    await f.close();
  }
});

test("other providers refuse a choice of Antigravity sign-in method before anything starts", async () => {
  const f = await antigravity();
  try {
    const result = await f.sessions.handle("device", {
      type: "provider.login.start",
      requestId: "codex-start",
      provider: "codex",
      signIn: { method: "google" },
    });
    expect(result.result).toEqual({ ok: false, error: "invalid_input" });
    expect(f.prepared()).toBe(0);
  } finally {
    await f.close();
  }
});
