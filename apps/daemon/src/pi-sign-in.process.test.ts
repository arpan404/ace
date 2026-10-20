import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { ProviderLoginSessions, type ProviderLoginDriver } from "@ace/accounts";
import type { ProviderLoginProgress } from "@ace/protocol";
import { TerminalManager, createPosixBackendFactory } from "@ace/terminal";
import { cliLoginDriver } from "./provider-login-driver.ts";
import { piKeyHandOff } from "./pi-login-driver.ts";
import { apiKeyLoginDriver } from "./provider-api-key.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

/** A Pi 1.3-shaped install: its SDK lists providers and saved sign-ins, never secrets. */
async function pi() {
  const root = await mkdtemp(join(tmpdir(), "ace-pi-sign-in-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.3.0",
      type: "module",
      main: "./dist/index.js",
    }),
  );
  const command = join(root, "dist", "pi");
  await writeFile(
    command,
    `#!${process.execPath}\nif(process.argv.includes('--version')) console.log('1.3.0');\n`,
    { mode: 0o755 },
  );
  const log = join(root, "sdk.log");
  await writeFile(
    join(root, "dist", "index.js"),
    `
import fs from 'node:fs';
const log = (entry) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
const oauth = (name) => ({ oauth: { name, login() {} } });
export class SettingsManager {
  static create() { return { getOrCreateDeviceId: () => '11111111-2222-4333-8444-555555555555' }; }
}
export class ModelRuntime {
  static async create(options) { if (options.refreshOnCreate !== false) throw Error('Unexpected refresh'); return new ModelRuntime(); }
  getProviders() {
    return [
      { id: 'anthropic', name: 'Anthropic', auth: oauth('Anthropic (Claude Pro/Max)') },
      { id: 'xai', name: 'xAI', auth: oauth('xAI (Grok/X subscription)') },
      { id: 'openai-codex', name: 'OpenAI Codex (legacy)', auth: oauth('OpenAI (ChatGPT Plus/Pro)') },
      { id: 'groq', name: 'Groq', auth: { apiKey: { name: 'Groq API key' } } },
      { id: 'openrouter', name: 'OpenRouter', auth: oauth('OpenRouter OAuth') },
      { id: 'github-copilot', name: 'GitHub Copilot', auth: oauth('GitHub Copilot') },
      { id: 'openai', name: 'OpenAI', auth: oauth('OpenAI (ChatGPT subscription)') },
    ];
  }
  async listCredentials() { return [{ providerId: 'openrouter', type: 'oauth' }]; }
  async login(provider, type, interaction, options) {
    if (type === 'api_key') {
      const key = await interaction.prompt({ type: 'secret', message: 'API key' });
      log({ key: provider, value: key });
      return { type: 'api_key', key };
    }
    // Like Pi's ChatGPT sign-in: it needs the installation id Pi's own settings keep.
    const host = options?.getDeviceId?.();
    if (!host) throw Error('Sign in with ChatGPT requires a device ID');
    interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/api/accounts/authorize?client_id=c&agent_name_hint=pi&ext_agent_host_id=urn%3Auuid%3A' + host + '&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&resource=https%3A%2F%2Fapi.openai.com%2Fv1&scope=openid&state=s&code_challenge=c&code_challenge_method=S256&nonce=n' });
    log({ login: provider });
    return { type: 'oauth', access: 'sk-never-relayed', refresh: 'r', expires: 1 };
  }
  async logout(provider) { log({ logout: provider }); }
}`,
  );
  const env = { HOME: root, PI_CODING_AGENT_DIR: join(root, "profile") };
  const sdkLog = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>);
  return { root, command, env, sdkLog };
}

async function sessions(prepare: (action: "login" | "logout") => Promise<ProviderLoginDriver>) {
  const events: ProviderLoginProgress[] = [];
  const owner = new ProviderLoginSessions({
    now: () => 1,
    id: () => "pi-login",
    schedule: () => () => {},
    prepare: (_target, action) => prepare(action),
  });
  cleanups.push(() => owner.close());
  owner.listen((_owner, progress) => events.push(progress));
  return {
    events,
    owner,
    choices: async () => {
      await expect.poll(() => events.at(-1)?.choices?.length ?? 0).toBeGreaterThan(0);
      return events.at(-1)?.choices ?? [];
    },
    choose: (choice: string) =>
      owner.handle("owner", {
        type: "provider.login.input",
        requestId: `choose-${choice}`,
        session: "pi-login",
        input: { choice },
      }),
    done: () => owner.completed("owner", "pi-login"),
  };
}

async function signIn() {
  const f = await pi();
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: { backendFactory: createPosixBackendFactory(undefined, f.root) },
  });
  cleanups.push(() => manager.closeAll());
  const terminals: string[] = [];
  const s = await sessions(async (action) =>
    cliLoginDriver({
      provider: "pi",
      action,
      command: f.command,
      version: "1.3.0",
      help: "",
      cwd: f.root,
      env: f.env,
      manager,
      openTerminal(launch) {
        terminals.push(launch.shell ?? "");
        return { id: "pi-terminal", exited: Promise.resolve(true), stop: async () => {} };
      },
    }),
  );
  return { ...f, ...s, terminals };
}

test("Pi offers its own sign-ins: ChatGPT's current one over legacy Codex, and Other last", async () => {
  const f = await signIn();
  await f.owner.handle("owner", { type: "provider.login.start", requestId: "s", provider: "pi" });
  expect(await f.choices()).toEqual([
    { id: "github-copilot", label: "GitHub Copilot" },
    { id: "openai", label: "OpenAI (ChatGPT subscription)" },
    { id: "anthropic", label: "Anthropic (Claude Pro/Max)" },
    { id: "openrouter", label: "OpenRouter OAuth" },
    { id: "xai", label: "xAI (Grok/X subscription)" },
    { id: "other", label: "Other provider" },
  ]);
  await f.choose("openai");
  expect((await f.done()).state).toBe("succeeded");
  // Pi's own installation id reaches OpenAI, and the page finishing here says so.
  expect(f.events).toContainEqual(
    expect.objectContaining({
      state: "awaiting_browser",
      url: expect.stringMatching(
        /^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?.*ext_agent_host_id=urn%3Auuid%3A11111111/,
      ),
      hint: expect.stringContaining("another device"),
    }),
  );
  expect(await f.sdkLog()).toEqual([{ login: "openai" }]);
  expect(JSON.stringify(f.events)).not.toContain("sk-never-relayed");
});

test("a provider whose page comes from its own server signs in through Pi's terminal at /login", async () => {
  const f = await signIn();
  await f.owner.handle("owner", { type: "provider.login.start", requestId: "s", provider: "pi" });
  await f.choices();
  await f.choose("xai");
  expect((await f.done()).state).toBe("succeeded");
  expect(f.terminals).toEqual([f.command]);
  expect(f.events).toContainEqual(
    expect.objectContaining({
      manual: expect.objectContaining({ instruction: expect.stringContaining("/login xai") }),
    }),
  );
  expect(await f.sdkLog()).toEqual([]);
});

test("Pi sign-out offers only the providers it has a saved sign-in for", async () => {
  const f = await signIn();
  await f.owner.handle("owner", { type: "provider.logout", requestId: "s", provider: "pi" });
  expect(await f.choices()).toEqual([{ id: "openrouter", label: "OpenRouter" }]);
  await f.choose("openrouter");
  expect((await f.done()).state).toBe("succeeded");
  expect(await f.sdkLog()).toEqual([{ logout: "openrouter" }]);
});

test("a Pi API key reaches the SDK's own key prompt for its provider and is never echoed back", async () => {
  const f = await pi();
  const s = await sessions(async () =>
    apiKeyLoginDriver({
      ...(await piKeyHandOff(f.command, "1.3.0", "openrouter", f.env)),
      cwd: f.root,
    }),
  );
  await s.owner.handle("owner", {
    type: "provider.login.start",
    requestId: "s",
    provider: "pi",
    method: "api_key",
    upstream: "openrouter",
  });
  await expect.poll(() => s.events.at(-1)?.state).toBe("awaiting_api_key");
  await s.owner.handle("owner", {
    type: "provider.login.apiKey",
    requestId: "key",
    session: "pi-login",
    apiKey: "sk-or-synthetic-key",
  });
  expect((await s.done()).state).toBe("succeeded");
  expect(await f.sdkLog()).toEqual([{ key: "openrouter", value: "sk-or-synthetic-key" }]);
  expect(JSON.stringify(s.events)).not.toContain("sk-or-synthetic-key");
});
