// SPDX-License-Identifier: Apache-2.0

/*
 * Generates `native/daemon/crates/ace-adapter-opencode/src/session/api/routes.golden.json`,
 * the OpenCode call table's proof (E3-opencode.6): for every SDK call the Rust session makes,
 * the method, request target and JSON body the `@opencode/client` in `node_modules` actually
 * sends. The client is driven with a capturing fetch, so the query's bracket encoding, the
 * order of its fields, the path's percent-encoding and each route's body field whitelist all
 * come from the SDK, never from a hand-written expectation.
 *
 *   bun scripts/opencode-routes.ts [--check]
 *
 * The output is committed and `bun run check:daemon-native` regenerates it and fails on a
 * diff, so bumping the SDK fails the check until the golden (and, if it moved, the Rust table)
 * follows. The Rust test `session/api/tests.rs` then builds each call from the same params and
 * compares it with this file, field for field.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(
  root,
  "native/daemon/crates/ace-adapter-opencode/src/session/api/routes.golden.json",
);
const check = process.argv.includes("--check");

/** The package the adapter pins, so the cache fallback cannot drift from it. */
function pinnedVersion(): string {
  const manifest = readFileSync(join(root, "packages/adapter-opencode/package.json"), "utf8");
  const version = /"@opencode\/client":\s*"([^"]+)"/.exec(manifest)?.[1];
  if (version === undefined) throw new Error("@opencode/client is not pinned in adapter-opencode");
  return version;
}

/**
 * The client package: the worktree's install first (what CI uses), then `OPENCODE_CLIENT_DIR`,
 * then bun's cache for the pinned version, so the golden regenerates without an install and
 * can never silently read an unpinned release.
 */
function clientDir(): string {
  const installed = join(root, "node_modules/@opencode/client");
  if (existsSync(join(installed, "package.json"))) return installed;
  const fromEnv = process.env.OPENCODE_CLIENT_DIR;
  if (fromEnv !== undefined && existsSync(join(fromEnv, "package.json"))) return fromEnv;
  const cached = join(homedir(), ".bun/install/cache", `@opencode/client@${pinnedVersion()}@@@1`);
  if (existsSync(join(cached, "package.json"))) return cached;
  throw new Error(
    "run `bun install`, or point OPENCODE_CLIENT_DIR at an unpacked @opencode/client",
  );
}

/** An SDK method: the generated client takes one input object. */
type Method = (input?: Record<string, unknown>) => unknown;

/** The client's methods the probes call, at the paths the adapter's TypeScript uses. */
interface Client {
  readonly session: {
    readonly create: Method;
    readonly get: Method;
    readonly list: Method;
    readonly active: () => unknown;
    readonly update: Method;
    readonly switchAgent: Method;
    readonly switchModel: Method;
    readonly interrupt: Method;
    readonly prompt: Method;
    readonly command: Method;
    readonly environment: Method;
    readonly instructions: { readonly entry: { readonly put: Method } };
    readonly message: { readonly get: Method };
    readonly form: { readonly list: Method; readonly reply: Method; readonly cancel: Method };
    readonly inbox: { readonly list: Method };
  };
  readonly message: { readonly list: Method };
  readonly permission: { readonly list: Method; readonly reply: Method };
  readonly shell: { readonly list: Method; readonly get: Method; readonly remove: Method };
  readonly model: { readonly list: Method; readonly default: Method };
  readonly command: { readonly list: Method };
  readonly skill: { readonly list: Method };
  readonly agent: { readonly list: Method };
  readonly plugin: { readonly list: Method };
  readonly mcp: { readonly list: Method; readonly add: Method; readonly connect: Method };
  readonly integration: { readonly list: Method };
  readonly rpc: { readonly call: Method };
  readonly event: { readonly subscribe: () => AsyncIterable<unknown> };
}

interface Probe {
  /** The Rust table's name for the call. */
  readonly op: string;
  /** The SDK method that builds the request, as the adapter's TypeScript calls it. */
  readonly send: (client: Client, params: Record<string, unknown>) => unknown;
  /** The params the Rust table receives, with noise fields a caller may carry. */
  readonly params: Record<string, unknown>;
}

/** The ids every probe shares, so paths and bodies read the same across the table. */
const session = {
  sessionID: "ses_1",
  messageID: "msg_1",
  requestID: "per_1",
  formID: "frm_1",
};
const location = { directory: "/work" };

/** A field no route declares: it must never reach a path, query or body. */
const noise = { kind: "noise", unused: "noise" };

const probes: readonly Probe[] = [
  {
    op: "session.create",
    send: (c, p) => c.session.create(p),
    params: {
      id: "ses_new",
      parentID: "ses_parent",
      title: "ace",
      agent: "build",
      model: { providerID: "anthropic", id: "claude", variant: "high" },
      location,
      metadata: { source: "ace" },
      permissions: { edit: "ask" },
      ...noise,
    },
  },
  {
    // An id with a slash, a query separator, a space and a sub-delimiter: the SDK percent-encodes
    // the segment with `encodeURIComponent`, and the golden pins what reaches the wire.
    op: "session.get",
    send: (c, p) => c.session.get(p),
    params: { sessionID: "a/b?c d!'()~*", ...noise },
  },
  {
    op: "session.list",
    send: (c, p) => c.session.list(p),
    params: {
      limit: 128,
      order: "asc",
      search: "need le!'()~*",
      parentID: "ses_parent",
      directory: "/work",
      project: "prj",
      subpath: "sub/dir",
      cursor: "children:2",
      ...noise,
    },
  },
  {
    op: "session.active",
    send: (c) => c.session.active(),
    params: {},
  },
  {
    op: "session.update",
    send: (c, p) => c.session.update(p),
    params: {
      ...session,
      title: "ace",
      metadata: { source: "ace" },
      permissions: { edit: "ask" },
      ...noise,
    },
  },
  {
    op: "session.switchAgent",
    send: (c, p) => c.session.switchAgent(p),
    params: { ...session, agent: "build", ...noise },
  },
  {
    op: "session.switchModel",
    send: (c, p) => c.session.switchModel(p),
    params: {
      ...session,
      model: { providerID: "anthropic", id: "claude", variant: "high" },
      ...noise,
    },
  },
  {
    op: "session.interrupt",
    send: (c, p) => c.session.interrupt(p),
    params: { ...session, resume: true, ...noise },
  },
  {
    op: "session.prompt",
    send: (c, p) => c.session.prompt(p),
    params: {
      ...session,
      id: "msg_2",
      text: "hello",
      files: [{ path: "a.txt", mime: "text/plain" }],
      agents: ["build"],
      skills: ["review"],
      metadata: { source: "ace" },
      delivery: "async",
      resume: false,
      ...noise,
    },
  },
  {
    op: "session.command",
    send: (c, p) => c.session.command(p),
    params: {
      ...session,
      name: "init",
      text: "hello",
      files: [{ path: "a.txt", mime: "text/plain" }],
      agents: ["build"],
      skills: ["review"],
      delivery: "async",
      ...noise,
    },
  },
  {
    op: "session.environment",
    send: (c, p) => c.session.environment(p),
    params: { ...session, variables: { ACE_CONTEXT: "1" }, ...noise },
  },
  {
    op: "session.instructions.put",
    send: (c, p) => c.session.instructions.entry.put(p),
    params: { ...session, key: "ace.tool-guidance", value: "guidance", ...noise },
  },
  {
    op: "session.message.get",
    send: (c, p) => c.session.message.get(p),
    params: { ...session, ...noise },
  },
  {
    op: "message.list",
    send: (c, p) => c.message.list(p),
    params: { ...session, limit: 64, order: "desc", cursor: "cursor:1", type: "user", ...noise },
  },
  {
    op: "permission.list",
    send: (c, p) => c.permission.list(p),
    params: { ...session, ...noise },
  },
  {
    // The TypeScript's resolution object carries `kind`, `answer` and `cancel` too.
    op: "permission.reply",
    send: (c, p) => c.permission.reply(p),
    params: {
      ...session,
      decision: "once",
      message: "yes",
      answer: { q: "a" },
      cancel: false,
      ...noise,
    },
  },
  {
    op: "session.form.list",
    send: (c, p) => c.session.form.list(p),
    params: { ...session, ...noise },
  },
  {
    op: "session.form.reply",
    send: (c, p) => c.session.form.reply(p),
    params: {
      ...session,
      cancel: false,
      message: "noise",
      answer: { q: "a" },
      ...noise,
    },
  },
  {
    op: "session.form.cancel",
    send: (c, p) => c.session.form.cancel(p),
    params: {
      ...session,
      cancel: true,
      message: "dismissed",
      answer: { q: "a" },
      ...noise,
    },
  },
  {
    op: "session.inbox.list",
    send: (c, p) => c.session.inbox.list(p),
    params: { ...session, ...noise },
  },
  { op: "shell.list", send: (c, p) => c.shell.list(p), params: { location, ...noise } },
  {
    op: "shell.get",
    send: (c, p) => c.shell.get(p),
    params: { id: "sh_1", location, ...noise },
  },
  {
    op: "shell.remove",
    send: (c, p) => c.shell.remove(p),
    params: { id: "sh_1", location, ...noise },
  },
  { op: "model.list", send: (c, p) => c.model.list(p), params: { location, ...noise } },
  { op: "model.default", send: (c, p) => c.model.default(p), params: { location, ...noise } },
  { op: "command.list", send: (c, p) => c.command.list(p), params: { location, ...noise } },
  { op: "skill.list", send: (c, p) => c.skill.list(p), params: { location, ...noise } },
  { op: "agent.list", send: (c, p) => c.agent.list(p), params: { location, ...noise } },
  { op: "plugin.list", send: (c, p) => c.plugin.list(p), params: { location, ...noise } },
  { op: "mcp.list", send: (c, p) => c.mcp.list(p), params: { location, ...noise } },
  {
    op: "mcp.add",
    send: (c, p) => c.mcp.add(p),
    params: {
      server: "ace",
      location,
      config: { type: "remote", url: "http://127.0.0.1:1/mcp" },
      ...noise,
    },
  },
  {
    // No body: the SDK sends none, so a caller's extra field must not invent one.
    op: "mcp.connect",
    send: (c, p) => c.mcp.connect(p),
    params: { server: "ace", location, config: { type: "remote" }, ...noise },
  },
  {
    op: "agent.environment.settle",
    send: (c, p) =>
      c.rpc.call({
        rpcID: "ace.agent.environment",
        method: "settle",
        location: p.location,
        input: p.input,
      }),
    params: {
      location,
      input: { sessionID: "ses_1", ok: true, message: "settled" },
      ...noise,
    },
  },
  {
    op: "mcp.readiness.ready",
    send: (c, p) =>
      c.rpc.call({
        rpcID: "ace.mcp.readiness",
        method: "ready",
        location: p.location,
        input: p.input,
      }),
    params: { location, input: {}, ...noise },
  },
  { op: "integration.list", send: (c, p) => c.integration.list(p), params: { location, ...noise } },
  { op: "event.subscribe", send: (c) => c.event.subscribe(), params: {} },
];

interface Captured {
  readonly url: URL;
  readonly method: string;
  readonly body: string | undefined;
}

/**
 * Sends one probe through a fresh client over a capturing fetch. The SDK compares the reply's
 * status and content type with the route's own and may throw; the capture is taken before
 * either, so one plain JSON reply serves every probe.
 */
async function captured(make: (options: unknown) => Client, probe: Probe): Promise<Captured> {
  const seen: Captured[] = [];
  const fetch = async (url: URL, init: RequestInit) => {
    seen.push({
      url,
      method: String(init.method),
      body: typeof init.body === "string" ? init.body : undefined,
    });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = make({ baseUrl: "http://127.0.0.1:4096/", fetch });
  const sent = probe.send(client, probe.params);
  if (probe.op === "event.subscribe") {
    // `sse` sends on the iterator's first pull, not when the iterator is created.
    const iterator = (sent as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    await iterator.next().catch(() => undefined);
  } else {
    await Promise.resolve(sent).catch(() => undefined);
  }
  if (seen.length !== 1) throw new Error(`${probe.op} sent ${seen.length} requests`);
  return seen[0]!;
}

async function generate(): Promise<string> {
  const dir = clientDir();
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  if (manifest.name !== "@opencode/client")
    throw new Error(`${dir} is ${manifest.name}, not @opencode/client`);
  // The client package resolves by path at run time, so its types arrive by hand.
  const { make } = (await import(
    pathToFileURL(join(dir, "dist/promise/client.js")).href
  )) as unknown as { make: (options: unknown) => Client };
  const entry = {
    generator: "scripts/opencode-routes.ts",
    client: `${manifest.name} ${manifest.version}`,
    routes: [] as unknown[],
  };
  for (const probe of probes) {
    const sent = await captured(make, probe);
    const request: Record<string, unknown> = {
      op: probe.op,
      params: probe.params,
      method: sent.method,
      target: sent.url.pathname + sent.url.search,
    };
    if (sent.body !== undefined) request.body = JSON.parse(sent.body);
    entry.routes.push(request);
  }
  return `${JSON.stringify(entry, null, 2)}\n`;
}

const text = await generate();
if (check) {
  const committed = existsSync(output) ? readFileSync(output, "utf8") : "";
  if (committed !== text) {
    console.error(
      `opencode-routes: ${output} is stale; run \`bun scripts/opencode-routes.ts\` and commit it`,
    );
    process.exit(1);
  }
} else {
  writeFileSync(output, text);
}
