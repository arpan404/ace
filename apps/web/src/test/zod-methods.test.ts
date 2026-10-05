import { join } from "node:path";
import { RegistryAgent, ServerMessage } from "@ace/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { build, type Plugin, type Rolldown } from "vite";
import { z } from "zod";
import { zodWithoutUnusedMethods } from "../../zod-methods.ts";

/*
 * Bundles the protocol and classic Zod with and without the plugin, as the browser build does,
 * and runs the result: the protocol must build and decode exactly as it does from source.
 */

const web = join(import.meta.dirname, "../..");
// Not a file on disk: the `entry` plugin supplies its source. `ServerMessage` reaches every
// protocol family, so bundling it builds every schema the browser loads.
const entryFile = join(web, "zod-methods-entry.js");
const entry: Plugin = {
  name: "entry",
  enforce: "pre",
  resolveId: (id) => (id === entryFile ? "\0entry" : null),
  load: (id) =>
    id === "\0entry"
      ? `export { RegistryAgent, ServerMessage } from "@ace/protocol"; export { number, string } from "zod";`
      : null,
};

async function bundle(plugins: Plugin[]): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: web,
    plugins: [entry, ...plugins],
    build: {
      write: false,
      minify: false,
      lib: { entry: entryFile, formats: ["cjs"], fileName: "entry" },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const chunk = outputs[0]?.output.find((output) => output.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("No chunk in the bundle");
  return chunk.code;
}

interface Bundled {
  RegistryAgent: typeof RegistryAgent;
  ServerMessage: typeof ServerMessage;
  number: typeof z.number;
  string: typeof z.string;
}

/** Runs a self-contained CommonJS bundle and returns its exports. */
function load(code: string): Bundled {
  const module = { exports: {} };
  new Function("module", "exports", code)(module, module.exports);
  return module.exports as Bundled;
}

let full = "";
let trimmed = "";
let browser: Bundled;

beforeAll(async () => {
  [full, trimmed] = await Promise.all([bundle([]), bundle([zodWithoutUnusedMethods()])]);
  browser = load(trimmed);
}, 60_000);

const event = { seq: 5, id: "e", at: 5, threadId: "t", payload: { type: "thread.updated" } };
const messages: unknown[] = [
  { type: "snapshot", subscriptionId: "s", seq: 3, view: { kind: "threads", seq: 3, threads: {} } },
  { type: "snapshot", subscriptionId: "s", seq: 3, view: { kind: "threads", seq: 2, threads: {} } },
  { type: "events", subscriptionId: "s", afterSeq: 2, throughSeq: 8, events: [event] },
  { type: "events", subscriptionId: "s", afterSeq: 2, throughSeq: 4, events: [event] },
  { type: "progress", subscriptionId: "s", afterSeq: 2, throughSeq: 8 },
  { type: "nonsense" },
];
const agent = {
  acpAgentId: "a",
  name: "Agent",
  version: "1",
  description: "",
  source: "https://example.com/agent",
  authors: [],
  availability: "available",
  coverage: "generic",
  auth: "unknown",
  loginHint: "",
  visibility: "limited",
  isolation: "unsupported",
};

describe("zodWithoutUnusedMethods", () => {
  it("keeps every protocol schema decoding as it does from source", () => {
    for (const message of messages)
      expect(browser.ServerMessage.safeParse(message).success).toBe(
        ServerMessage.safeParse(message).success,
      );
    for (const source of ["https://example.com/agent", "not a url"])
      expect(browser.RegistryAgent.safeParse({ ...agent, source }).success).toBe(
        RegistryAgent.safeParse({ ...agent, source }).success,
      );
    expect(browser.string().url().safeParse("https://example.com").success).toBe(true);
    expect(browser.string().uuid().safeParse("nope").success).toBe(false);
  });

  it("takes the dropped methods' code out of the bundle", () => {
    expect(trimmed.length).toBeLessThan(full.length - 10_000);
  });

  it("fails loudly when code calls a dropped method", () => {
    expect(() => browser.string().email()).toThrow(/left out of browser builds/);
    expect(() => browser.number().multipleOf(2)).toThrow(/left out of browser builds/);
    expect(() => browser.string().decode("x")).toThrow(/left out of browser builds/);
  });
});
