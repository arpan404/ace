import { expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AccountService, openRegistry } from "@ace/accounts";
import { ModelCatalog, openModelStorage, createModelDiscovery } from "@ace/models";
import { NativeAccountProvider } from "@ace/protocol/accounts";
import { type ClientMessage, type ServerMessage } from "@ace/protocol";
import { AccountManagement } from "./account-management.ts";
import { fixture, type Client } from "./socket-test-support.ts";
import { setup } from "./remote-test-support.ts";

async function request(client: Client, message: ClientMessage): Promise<ServerMessage> {
  client.send(message);
  for (;;) {
    const reply = await client.next();
    if ("requestId" in message && "requestId" in reply && reply.requestId === message.requestId)
      return reply;
  }
}

export const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 10000 });

// All commands are controlled binaries. The marker represents a fake CLI's status, not a credential.
const cli = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const provider = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR || process.env.CURSOR_CONFIG_DIR || process.env.PI_CODING_AGENT_DIR || process.env.XDG_DATA_HOME;
const marker = path.join(home, 'fixture-signed-in');
if (args[0] === '--version') {
  console.log(provider === 'codex' ? 'codex-cli 0.150.0' : provider === 'agent' ? '2026.09.26-dd393fe' : '2.1.4');
} else if (args.join(' ') === 'login status' || args.join(' ') === 'auth status' || args[0] === 'status' || args[1] === 'list') {
  const signedIn = fs.existsSync(marker);
  console.log(provider === 'claude' ? JSON.stringify({loggedIn:signedIn}) : provider === 'opencode' ? (signedIn ? '1 credential' : 'No authenticated integrations') : (signedIn ? 'Logged in using ChatGPT' : 'Not logged in'));
} else if (args[0] === 'app-server') {
  const lines = readline.createInterface({input:process.stdin});
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === 'model/list' && fs.existsSync(path.join(home, 'fixture-hold-model'))) {
      fs.writeFileSync(path.join(home, 'fixture-model-pid'), String(process.pid));
      return;
    }
    const result = request.method === 'model/list' ? {data:[{id:'fixture',model:'fixture-account-model',displayName:'Fixture model',isDefault:true,supportedReasoningEfforts:[],defaultReasoningEffort:'high'}],nextCursor:null} : {};
    console.log(JSON.stringify({id:request.id,result}));
  });
} else if (args.length && !args.includes('login') && !args.includes('logout')) {
  process.exit(1);
} else {
  fs.writeFileSync(path.join(process.cwd(), 'fixture-launch.json'), JSON.stringify({args, env:Object.fromEntries(['CODEX_HOME','CLAUDE_CONFIG_DIR','CURSOR_CONFIG_DIR','CURSOR_DATA_DIR','AGENT_CLI_CREDENTIAL_STORE','PI_CODING_AGENT_DIR','HOME','XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','TMPDIR','OPENAI_API_KEY'].map(key=>[key,process.env[key] ?? null]))}));
  console.log('fixture-auth-output-private');
  const lines = readline.createInterface({input:process.stdin});
  lines.on('line', (line) => {
    if (line.trim() !== 'finish') return;
    const logout = args.includes('logout');
    fs.mkdirSync(home, {recursive:true});
    if (logout) fs.rmSync(marker, {force:true});
    else fs.writeFileSync(marker, 'fixture marker');
    process.exit(0);
  });
}
`;
export async function harness(remote = false) {
  const root = await mkdtemp(join(tmpdir(), "ace-managed-accounts-"));
  const dataDir = join(root, "daemon");
  const normalHome = join(root, "normal-home");
  const bin = join(root, "bin");
  await Promise.all([mkdir(dataDir), mkdir(normalHome), mkdir(bin)]);
  await writeFile(join(normalHome, "untouched"), "normal CLI home");
  for (const name of ["codex", "claude", "opencode", "agent", "pi"])
    await writeFile(join(bin, name), cli, { mode: 0o700 });
  // Override inherited account selectors so every test instance follows its own home.
  const env = {
    ...process.env,
    PATH: bin,
    HOME: normalHome,
    CODEX_HOME: undefined,
    CLAUDE_CONFIG_DIR: undefined,
    CURSOR_CONFIG_DIR: undefined,
    CURSOR_DATA_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
    OPENAI_API_KEY: "ambient-fixture-value",
  };
  const registry = await openRegistry(join(dataDir, "accounts.sqlite"));
  const accounts = new AccountService({ registry, env, now: () => 100, timeZone: "UTC" });
  const models = new ModelCatalog({
    storage: openModelStorage(join(dataDir, "models.sqlite")),
    now: () => 100,
    deadline: (expire, ms) => {
      const timer = setTimeout(expire, ms);
      return () => clearTimeout(timer);
    },
    discover: createModelDiscovery(),
  });
  const management = new AccountManagement({
    registry,
    accounts,
    dataDir,
    env,
    now: () => 100,
    id: randomUUID,
    terminal: { graceMs: 50 },
    models: () => models,
  });
  await management.initialize();
  const remoteSocket = remote
    ? await setup({ accounts, accountManagement: management, models })
    : undefined;
  const socket =
    remoteSocket ?? (await fixture({ accounts, accountManagement: management, models }));
  const owner = await socket.connect();
  await owner.next();
  let sequence = 0;
  const rid = () => `request-${++sequence}`;
  async function add(provider: (typeof NativeAccountProvider.options)[number] = "codex") {
    const reply = await request(owner, {
      type: "accounts.add",
      requestId: rid(),
      provider,
      label: "Work",
    });
    if (reply.type !== "accounts.changed" || !reply.account) throw new Error(JSON.stringify(reply));
    return reply.account;
  }
  async function flow(instanceId: string, action: "login" | "logout") {
    const reply = await request(owner, {
      type: action === "login" ? "accounts.login" : "accounts.logout",
      requestId: rid(),
      instanceId,
    });
    if (reply.type !== "accounts.auth") throw new Error(JSON.stringify(reply));
    owner.send({
      type: "terminal.request",
      requestId: rid(),
      operation: {
        op: "subscribe",
        terminalId: reply.terminalId,
        subscriptionId: reply.terminalId,
        fromOffset: 0,
      },
    });
    expect(await owner.next()).toMatchObject({ type: "terminal.result", ok: true });
    let output = "";
    while (!output.includes("fixture-auth-output-private")) {
      const event = await owner.next();
      if (event.type === "terminal.result" && !event.ok) throw new Error(JSON.stringify(event));
      if (event.type === "terminal.output" && event.event.type === "data")
        output += event.event.data;
    }
    owner.send({
      type: "terminal.request",
      requestId: rid(),
      operation: { op: "write", terminalId: reply.terminalId, data: "finish\n" },
    });
    for (;;) {
      const event = await owner.next();
      if (event.type === "terminal.output" && event.event.type === "exit") {
        expect(event.event.status.code).toBe(0);
        break;
      }
    }
    return reply;
  }
  async function status(instanceId: string) {
    const reply = await request(owner, { type: "accounts.status", requestId: rid(), instanceId });
    if (reply.type !== "accounts.status") throw new Error(JSON.stringify(reply));
    return reply.account;
  }
  async function close() {
    await socket.close();
    await management.close();
    await models.close();
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
  return {
    ...socket,
    remote: remoteSocket,
    root,
    dataDir,
    normalHome,
    bin,
    owner,
    request,
    rid,
    add,
    flow,
    status,
    registry,
    management,
    models,
    close,
  };
}
