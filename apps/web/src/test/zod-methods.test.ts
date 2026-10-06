import { createRequire } from "node:module";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { build, type Plugin, type Rolldown } from "vite";
import type { z } from "zod";
import { zodWithoutJsonSchema, zodWithoutMetadata } from "../../zod-json-schema.ts";
import {
  droppedZodMethods,
  droppedWorkerZodMethods,
  zodWithoutUnusedMethods,
} from "../../zod-methods.ts";
import { zodPureSchemas } from "../../zod-pure-schemas.ts";
import { workerZod } from "../../worker-zod.ts";
import { protocolCorpus, type ProtocolCorpus } from "./protocol-corpus.ts";

/*
 * Bundles the protocol, the page's and worker's own schemas and classic Zod twice, with the
 * browser build's Zod plugins, once without `zodWithoutUnusedMethods` and once with it, and runs
 * both. Over real daemon and client traffic and edge cases made from it, the two must decode
 * every input to the same value, or reject it with the same issues.
 */

const web = join(import.meta.dirname, "../..");
// Not a file on disk: the `entry` plugin supplies its source.
const entryFile = join(web, "zod-methods-entry.js");
const entrySource = `
export { ClientMessage, ServerMessage } from "@ace/protocol";
export { DaemonTarget } from "@/boot/connection-settings.ts";
export { WorkerTarget } from "@/boot/worker-target.ts";
export { MachineTarget } from "@/boot/machine-target.ts";
export { TabMessage, WorkerMessage } from "@ace/client-worker/wire";
export { ShellLayout } from "@/lib/layout.tsx";
export { Choices } from "@/features/home/new-thread/choices.ts";
export { AutomationForm } from "@/features/automations/automation-values.ts";
export { PluginNameInput, PluginRepository } from "@/features/skills/skills-model.ts";
export { NewDeckInput } from "@/features/deck/deck-spec.ts";
export { number, object, string } from "zod";
`;
const entry: Plugin = {
  name: "entry",
  enforce: "pre",
  resolveId: (id) => (id === entryFile ? "\0entry" : null),
  load: (id) => (id === "\0entry" ? entrySource : null),
};

async function bundle(plugins: Plugin[], source = entrySource): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: web,
    resolve: { alias: { "@": join(web, "src") } },
    plugins: [
      { ...entry, load: (id) => (id === "\0entry" ? source : null) },
      zodWithoutJsonSchema(),
      ...plugins,
    ],
    build: {
      write: false,
      target: "es2023",
      lib: { entry: entryFile, formats: ["cjs"], fileName: "entry" },
      rolldownOptions: {
        external: (id) => /^react($|\/|-dom)/.test(id),
        // One file to run: lazily loaded worker code comes along inline.
        output: { inlineDynamicImports: true },
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const chunk = outputs[0]?.output.find((output) => output.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("No chunk in the bundle");
  return chunk.code;
}

interface Issue {
  code: string;
  path: PropertyKey[];
  message: string;
}
/** What both classic and mini schemas offer. */
interface Schema {
  safeParse(
    input: unknown,
  ): { success: true; data: unknown } | { success: false; error: { issues: Issue[] } };
}
type Bundled = Record<string, Schema> & {
  number: typeof z.number;
  object: typeof z.object;
  string: typeof z.string;
};

/** Runs a CommonJS bundle and returns its exports; React stays outside it. */
function load(code: string): Bundled {
  const module = { exports: {} };
  const require = createRequire(join(web, "package.json"));
  new Function("module", "exports", "require", code)(module, module.exports, require);
  return module.exports as Bundled;
}

/**
 * What a parse means to a caller: the decoded value, each issue's code, path and message, or
 * the error a check threw.
 */
function outcome(schema: Schema, input: unknown) {
  let result: ReturnType<Schema["safeParse"]>;
  try {
    result = schema.safeParse(input);
  } catch (error) {
    return { ok: false, threw: error instanceof Error ? error.message : String(error) };
  }
  return result.success
    ? { ok: true, data: result.data }
    : {
        ok: false,
        issues: result.error.issues.map(({ code, path, message }) => ({ code, path, message })),
      };
}

const clone = <T>(value: T): T => structuredClone(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every place in a frame below its root, by path: objects, arrays and their entries. */
function places(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  const here = path.length ? [path] : [];
  if (Array.isArray(value))
    return [...here, ...value.flatMap((item, index) => places(item, [...path, index]))];
  if (isRecord(value))
    return [
      ...here,
      ...Object.entries(value).flatMap(([key, field]) => places(field, [...path, key])),
    ];
  return here;
}

/** A copy of `root` with the value at `path` replaced, or removed when `value` is `remove`. */
const remove = Symbol("remove");
function setAt(root: unknown, path: (string | number)[], value: unknown): unknown {
  const copy = clone(root);
  let at: unknown = copy;
  for (const key of path.slice(0, -1)) at = (at as Record<string | number, unknown>)[key];
  const parent = at as Record<string | number, unknown>;
  const last = path[path.length - 1] ?? "";
  if (value !== remove) parent[last] = value;
  else if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else delete parent[last];
  return copy;
}

/**
 * Edge cases made from a real frame: each changes one thing a decoder must handle. `deep` also
 * removes a sample of its nested fields and entries, or replaces them with wrong, empty,
 * oversized and boundary values.
 */
function variants(frame: unknown, deep: boolean): unknown[] {
  if (!isRecord(frame)) return [];
  const out: unknown[] = [
    { ...frame, unknownField: { nested: true } },
    { ...frame, type: "no.such.type" },
    // A record keyed by `__proto__`, as JSON on the wire can hold.
    JSON.parse(JSON.stringify(frame).replace(/^\{/, '{"__proto__":{"polluted":true},')),
  ];
  for (const key of Object.keys(frame)) {
    const { [key]: _dropped, ...rest } = frame;
    out.push(rest);
  }
  if (!deep) return out;
  const paths = places(frame);
  // A sample of places keeps the corpus fast while reaching every part of each message family.
  const step = Math.max(1, Math.floor(paths.length / 24));
  for (let index = 0; index < paths.length; index += step) {
    const path = paths[index];
    if (!path?.length) continue;
    out.push(setAt(frame, path, remove));
    out.push(setAt(frame, path, {}));
    out.push(setAt(frame, path, -1));
    out.push(setAt(frame, path, 1.5));
    out.push(setAt(frame, path, ""));
    out.push(setAt(frame, path, null));
    out.push(setAt(frame, path, "x".repeat(70_000)));
    out.push(setAt(frame, path, "https://example.com/a"));
  }
  return out;
}

/** Client requests as callers write them, before defaults are filled in. */
const rawRequests: unknown[] = [
  { type: "turns.page", requestId: "r1", threadId: "t" },
  { type: "turns.page", requestId: "r2", threadId: "t", before: 3, after: 1 },
  { type: "items.window", requestId: "r3", threadId: "t", turnOrdinal: 1 },
  { type: "items.window", requestId: "r4", threadId: "t", aroundSeq: 4, turnOrdinal: 1 },
  { type: "thread.search", requestId: "r5", threadId: "t", text: "the" },
  { type: "thread.search", requestId: "r6", threadId: "t", text: "" },
  { type: "thread.interrupt", threadId: "t" },
];

/** The page's and worker's own schemas, with inputs that reach their defaults and transforms. */
const browserInputs: Record<string, unknown[]> = {
  DaemonTarget: [
    { url: "ws://127.0.0.1:4242/", token: "token" },
    { url: "http://example.com", token: "token" },
    { url: "not a url", token: "" },
  ],
  WorkerTarget: [
    { url: "  wss://example.com/  ", token: "a".repeat(64), deviceId: "device", seed: null },
    { url: "wss://example.com/", token: "t", deviceId: "d", seed: null },
    { url: "wss://example.com/", token: "t", deviceId: "", seed: 1 },
  ],
  MachineTarget: [
    {
      url: "wss://build.local:4242/",
      token: "a".repeat(64),
      deviceId: "device",
      seed: null,
      hostId: "build",
    },
    { url: "wss://build.local:4242/", token: "t", deviceId: "d", seed: null, hostId: "" },
    { url: "wss://build.local:4242/", token: "t", deviceId: "d", seed: null },
  ],
  TabMessage: [
    { t: "connect", config: { daemon: "local" } },
    { t: "lease", lease: 1, scope: { kind: "thread", threadId: "t" } },
    { t: "call", call: 2, method: "request", args: [{ type: "accounts.list" }] },
    { t: "lease", lease: -1, scope: { kind: "thread", threadId: "" } },
    { t: "call", call: 1, method: "unknown", args: [] },
    { t: "bye", extra: true },
  ],
  WorkerMessage: [
    { t: "connection", state: "ready" },
    { t: "changes", leases: [{ lease: 1, patches: [{ k: "item:i", append: "tail" }] }] },
    { t: "failed", call: 1, error: { code: "protocol", message: "Invalid input" } },
    { t: "reply", call: "wrong" },
    { t: "changes", leases: [{ lease: 1, patches: "wrong" }] },
  ],
  ShellLayout: [{}, { sidebarOpen: false }, { sidebarOpen: "yes" }],
  Choices: [
    {},
    { project: "p", model: "m", mode: "worktree", fast: true },
    { project: "", model: 3, mode: "bogus", fast: "yes" },
  ],
  AutomationForm: [
    {
      title: "  Nightly  ",
      prompt: " Run the tests ",
      workspace: "w",
      provider: "codex",
      model: " ",
      trigger: "schedule",
      cadence: "custom",
      time: "09:30",
      day: "mon",
      every: 1,
      syntax: "cron",
      expression: " * * * ",
      repository: " ",
      event: "pr_changed",
      worktree: true,
      missedRun: "skip",
    },
    { title: "" },
  ],
  PluginRepository: ["  getsentry/sentry-mcp ", "https://example.com/repo.git", "nope", ""],
  PluginNameInput: [" Sentry-MCP ", "a..b", "-x", "x".repeat(70)],
  NewDeckInput: [
    {
      goal: "  Ship the bundle diet across every route  ",
      workspaceId: "w",
      worker: "codex",
      reviewer: "claude",
      planApproval: true,
      merge: "ask",
      maxParallel: 2,
      fixRounds: 1,
    },
    { goal: "short", maxParallel: 9 },
  ],
};

let full: Bundled;
let trimmed: Bundled;
let worker: Bundled;
let sizes: { full: number; trimmed: number };
let corpus: ProtocolCorpus;

beforeAll(async () => {
  const [fullCode, trimmedCode, workerCode, recorded] = await Promise.all([
    bundle([]),
    bundle([zodWithoutMetadata(), zodWithoutUnusedMethods(), zodPureSchemas(), workerZod()]),
    bundle(
      [
        zodWithoutMetadata(),
        zodWithoutUnusedMethods(droppedWorkerZodMethods),
        zodPureSchemas(),
        workerZod(),
      ],
      `
      export { ClientMessage, ServerMessage } from "@ace/protocol";
      export { WorkerTarget } from "@/boot/worker-target.ts";
      export { MachineTarget } from "@/boot/machine-target.ts";
      export { TabMessage, WorkerMessage } from "@ace/client-worker/wire";
      export { string, object, number } from "zod";
      // The machine-pool worker's entry loads with the worker build's Zod.
      import "@/boot/machine-worker.ts";
    `,
    ),
    protocolCorpus(),
  ]);
  full = load(fullCode);
  trimmed = load(trimmedCode);
  worker = load(workerCode);
  sizes = { full: gzipSync(fullCode).length, trimmed: gzipSync(trimmedCode).length };
  corpus = recorded;
}, 120_000);

/** Each frame with its edge cases; the deep ones for the first few frames of each type. */
function withVariants(frames: unknown[]): unknown[] {
  const seen = new Map<unknown, number>();
  return frames.flatMap((frame) => {
    const type = isRecord(frame) ? frame["type"] : undefined;
    const count = (seen.get(type) ?? 0) + 1;
    seen.set(type, count);
    return [frame, ...variants(frame, count <= 3)];
  });
}

/** Inputs on which the two builds disagree, described for the failure message. */
function disagreements(name: string, inputs: unknown[], actual = trimmed): string[] {
  const left = full[name];
  const right = actual[name];
  if (!left || !right) return [`${name} is missing from a bundle`];
  const found: string[] = [];
  for (const input of inputs) {
    const a = outcome(left, input);
    const b = outcome(right, input);
    try {
      expect(b).toStrictEqual(a);
    } catch {
      found.push(`${name}: ${JSON.stringify(input).slice(0, 200)}`);
    }
  }
  return found;
}

describe("zodWithoutUnusedMethods", () => {
  it("records real traffic from every part of the protocol the app uses", () => {
    const types = new Set(corpus.server.map((frame) => (frame as { type?: unknown }).type));
    for (const type of [
      "welcome",
      "snapshot",
      "events",
      "commandResult",
      "items.page",
      "turns.page",
      "items.window",
      "thread.search",
      "settings.result",
      "automation.result",
      "accounts.list",
      "usage.result",
    ])
      expect(types).toContain(type);
    expect(corpus.server.length).toBeGreaterThan(50);
    expect(corpus.client.length).toBeGreaterThan(20);
  });

  it("decodes every server frame, and edge cases made from them, as the full build does", () => {
    for (const frame of corpus.server) expect(outcome(full.ServerMessage!, frame).ok).toBe(true);
    const inputs = withVariants(corpus.server);
    expect(inputs.some((input) => !outcome(full.ServerMessage!, input).ok)).toBe(true);
    expect(disagreements("ServerMessage", inputs)).toEqual([]);
    expect(disagreements("ServerMessage", inputs, worker)).toEqual([]);
  }, 60_000);

  it("decodes every client frame and raw request as the full build does, defaults included", () => {
    for (const frame of corpus.client) expect(outcome(full.ClientMessage!, frame).ok).toBe(true);
    const defaulted = outcome(trimmed.ClientMessage!, rawRequests[0]);
    expect(defaulted).toMatchObject({ ok: true, data: { limit: 50 } });
    const inputs = withVariants([...corpus.client, ...rawRequests]);
    expect(disagreements("ClientMessage", inputs)).toEqual([]);
    expect(disagreements("ClientMessage", inputs, worker)).toEqual([]);
  }, 60_000);

  it("decodes the page's and worker's own schemas as the full build does", () => {
    const trimmedForm = outcome(trimmed.AutomationForm!, browserInputs["AutomationForm"]?.[0]);
    expect(trimmedForm).toMatchObject({ ok: false });
    expect(outcome(trimmed.PluginRepository!, "  getsentry/sentry-mcp ")).toEqual({
      ok: true,
      data: "https://github.com/getsentry/sentry-mcp.git",
    });
    expect(outcome(trimmed.Choices!, { mode: "bogus" })).toMatchObject({ ok: true });
    const found = Object.entries(browserInputs).flatMap(([name, inputs]) =>
      disagreements(name, inputs),
    );
    expect(found).toEqual([]);
  });

  it("takes the dropped methods' code out of the bundle", () => {
    expect(sizes.trimmed).toBeLessThan(sizes.full - 1_500);
  });

  it("keeps worker port decoding identical while sharing classic schema constructors", () => {
    for (const name of ["WorkerTarget", "MachineTarget", "TabMessage", "WorkerMessage"])
      expect(disagreements(name, browserInputs[name] ?? [], worker)).toEqual([]);
    expect(() => worker.string().catch("fallback")).toThrow(".catch() is left out");
    expect(trimmed.Choices?.safeParse({ mode: "bogus" }).success).toBe(true);
  });

  it("names unsupported worker methods while preserving validation issues", () => {
    const owners: Record<string, () => object> = {
      ZodType: () => worker.string(),
      ZodString: () => worker.string(),
      _ZodString: () => worker.string(),
      ZodNumber: () => worker.number(),
      ZodObject: () => worker.object({}),
      ZodError: () => worker.string().safeParse(42).error ?? {},
    };
    for (const [owner, names] of Object.entries(droppedWorkerZodMethods))
      for (const name of names) {
        const schema = owners[owner]?.() as Record<string, (...args: unknown[]) => unknown>;
        expect(() => schema[name]?.("x")).toThrow(`.${name}() is left out of browser builds`);
      }
    expect(worker.string().safeParse(42).error?.issues).toMatchObject([
      { code: "invalid_type", path: [] },
    ]);
  });

  it("fails loudly, naming the method, when code calls any dropped method", () => {
    const owners: Record<string, () => object> = {
      ZodType: () => trimmed.string(),
      ZodString: () => trimmed.string(),
      _ZodString: () => trimmed.string(),
      ZodNumber: () => trimmed.number(),
      ZodObject: () => trimmed.object({}),
    };
    for (const [owner, names] of Object.entries(droppedZodMethods))
      for (const name of names) {
        const schema = owners[owner]?.() as Record<string, (...args: unknown[]) => unknown>;
        expect(() => schema[name]?.("x")).toThrow(`.${name}() is left out of browser builds`);
      }
    // A kept method on the same prototype still works.
    expect(trimmed.string().url().safeParse("https://example.com").success).toBe(true);
  });
});
