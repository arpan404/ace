import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { ProviderLoginSessions } from "@ace/accounts";
import type { ProviderLoginProgress } from "@ace/protocol";
import { TerminalManager, createPosixBackendFactory } from "@ace/terminal";
import { cliLoginDriver } from "./provider-login-driver.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function setup(version = "1.1.0", deviceUrl = "https://auth.openai.com/codex/device") {
  const root = await mkdtemp(join(tmpdir(), "ace-pi-login-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version,
      type: "module",
      main: "./dist/index.js",
    }),
  );
  const command = join(root, "dist", "pi");
  await writeFile(
    command,
    `#!${process.execPath}
import readline from 'node:readline';
if(process.argv.includes('--version')) { console.log('${version}'); }
else if(process.argv.includes('--help')) { console.log('Usage: pi [options]. --mode --no-session'); }
else {
  console.log('Pi ready. Type /login');
  process.stdout.on('resize', () => console.log('Size: '+process.stdout.columns+'x'+process.stdout.rows));
  readline.createInterface({input:process.stdin}).on('line', line => {
    console.log('You typed: '+line);
    if(line === '/exit') process.exit(0);
  });
}`,
    { mode: 0o755 },
  );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const connected = once(server, "connection");
  await writeFile(
    join(root, "dist", "index.js"),
    `
import net from 'node:net';
export class ModelRuntime {
 static async create(options) { if(options.refreshOnCreate !== false) throw Error('Unexpected refresh'); return new ModelRuntime(); }
 async login(provider,type,interaction) {
  if(type !== 'oauth') throw Error('Wrong login');
  if(provider === 'openai-codex' || provider === 'anthropic') {
   const selected = await interaction.prompt({type:'select',options:[{id:'browser'},{id:'device_code'},{id:'copy_code'}]});
   if(selected !== (provider === 'openai-codex' ? 'device_code' : 'browser')) throw Error('Wrong method');
  }
  if(provider === 'github-copilot' && await interaction.prompt({type:'text',message:'GitHub Enterprise URL/domain (blank for github.com)'}) !== '') throw Error('Wrong host');
  if(provider === 'anthropic') interaction.notify({type:'auth_url',url:'https://claude.ai/oauth/authorize?code=true&client_id=fake&redirect_uri=http%3A%2F%2Flocalhost%3A12345%2Fcallback'});
  else interaction.notify({type:'device_code',verificationUri:provider==='openai-codex'?${JSON.stringify(deviceUrl)}:'https://github.com/login/device',userCode:'ABCD-1234'});
  const callback = new AbortController();
  const fallback = provider === 'anthropic' ? interaction.prompt({type:'manual_code',signal:callback.signal}).catch(()=>undefined) : undefined;
  await new Promise((resolve,reject)=>{ const socket = net.connect(${address.port},'127.0.0.1');socket.on('data',()=>{socket.end();resolve();});socket.on('error',reject); });
  callback.abort();
  await fallback;
  return { access:'sk-SDK-secret-never-relayed',refresh:'private-refresh',expires:9999 };
 }
 async logout() {}
}`,
  );
  const manager = new TerminalManager({
    graceMs: 0,
    dependencies: { backendFactory: createPosixBackendFactory(undefined, root) },
  });
  cleanups.push(() => manager.closeAll());
  const events: ProviderLoginProgress[] = [];
  const waiters: {
    predicate: (p: ProviderLoginProgress) => boolean;
    resolve(p: ProviderLoginProgress): void;
  }[] = [];
  const sessions = new ProviderLoginSessions({
    now: () => 1,
    id: () => "pi-login",
    schedule: () => () => {},
    prepare: async (_target, action) =>
      cliLoginDriver({
        provider: "pi",
        action,
        command,
        version,
        help: "",
        cwd: root,
        env: { HOME: root, PI_CODING_AGENT_DIR: join(root, "profile") },
        manager,
      }),
  });
  cleanups.push(() => sessions.close());
  sessions.listen((_owner, p) => {
    events.push(p);
    for (const waiter of waiters.splice(0)) {
      if (waiter.predicate(p)) waiter.resolve(p);
      else waiters.push(waiter);
    }
  });
  const wait = (predicate: (p: ProviderLoginProgress) => boolean) => {
    const found = events.findLast(predicate);
    return found
      ? Promise.resolve(found)
      : new Promise<ProviderLoginProgress>((resolve) => waiters.push({ predicate, resolve }));
  };
  const choose = (choice: string) =>
    sessions.handle("owner", {
      type: "provider.login.input",
      requestId: "choose",
      session: "pi-login",
      input: { choice },
    });
  return { root, command, manager, sessions, events, wait, choose, connected };
}

test.each(["0.85.1", "1.1.0"])(
  "Pi %s relays its own device login and completes without leaking credentials",
  async (version) => {
    const f = await setup(version);
    await f.sessions.handle("owner", {
      type: "provider.login.start",
      requestId: "start",
      provider: "pi",
    });
    const selection = await f.wait((p) => p.state === "awaiting_input");
    expect(selection.choices?.map((choice) => choice.label)).toEqual([
      "GitHub Copilot",
      "ChatGPT / Codex",
      "Claude",
      "Other provider",
    ]);
    await f.choose("openai-codex");
    const challenge = await f.wait((p) => !!p.url || p.state === "failed");
    expect(challenge).toMatchObject({
      state: "awaiting_code_entry",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    });
    const [socket] = await f.connected;
    socket.write("complete");
    await f.wait((p) => p.state === "succeeded");
    expect(f.events.some((p) => p.state === "failed")).toBe(false);
    expect(JSON.stringify(f.events)).not.toMatch(/SDK-secret|private-refresh/);
  },
);

test.each(["github-copilot", "anthropic"])(
  "Pi connects %s using its supported browser or device interaction",
  async (service) => {
    const f = await setup();
    await f.sessions.handle("owner", {
      type: "provider.login.start",
      requestId: "start",
      provider: "pi",
    });
    await f.wait((p) => p.state === "awaiting_input");
    await f.choose(service);
    expect(await f.wait((p) => !!p.url || p.state === "failed")).toMatchObject({
      state: service === "anthropic" ? "awaiting_browser" : "awaiting_code_entry",
      url: expect.stringContaining(service === "anthropic" ? "claude.ai" : "github.com"),
    });
    const [socket] = await f.connected;
    socket.write("complete");
    await f.wait((p) => p.state === "succeeded");
  },
);

test("cancelling Pi browser sign-in drains the SDK child before reporting cancellation", async () => {
  const f = await setup();
  await f.sessions.handle("owner", {
    type: "provider.login.start",
    requestId: "start",
    provider: "pi",
  });
  await f.wait((p) => p.state === "awaiting_input");
  await f.choose("github-copilot");
  await f.wait((p) => !!p.url);
  const [socket] = await f.connected;
  const closed = once(socket, "close");
  expect(
    await f.sessions.handle("owner", {
      type: "provider.login.cancel",
      requestId: "cancel",
      session: "pi-login",
    }),
  ).toMatchObject({ result: { progress: { state: "cancelled" } } });
  await closed;
  expect(socket.destroyed).toBe(true);
  expect(f.events.some((p) => p.state === "succeeded")).toBe(false);
});

test("Pi refuses a challenge that contains credentials and reports a real failure", async () => {
  const f = await setup("1.1.0", "https://auth.openai.com/codex/device?access_token=private-value");
  await f.sessions.handle("owner", {
    type: "provider.login.start",
    requestId: "start",
    provider: "pi",
  });
  await f.wait((p) => p.state === "awaiting_input");
  expect(f.events.some((p) => p.state === "failed")).toBe(false);
  await f.choose("openai-codex");
  await f.wait((p) => p.state === "failed");
  expect(f.events.some((p) => p.url || p.userCode)).toBe(false);
  expect(JSON.stringify(f.events)).not.toContain("private-value");
});
