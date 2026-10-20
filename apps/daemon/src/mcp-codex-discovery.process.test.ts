import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { bareToolName, codexInjection } from "@ace/mcp-server";
import { EvalAgent } from "./evals/agent.ts";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

/**
 * Codex lists every ace tool, but its code-mode models see only `exec`: they call ace tools as
 * `tools.mcp__ace__<name>(args)` without seeing a schema. Through the real daemon and a real
 * MCP client connected with Codex's own injection headers.
 */
let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
const tokens = (text: string) => Math.ceil(text.length / 4);

async function codexSession() {
  world = await evalWorld({ browser: false });
  const { agent: claude, connection } = await world.agent({});
  const injected = codexInjection(connection);
  const { Authorization: _credential, ...headers } =
    injected.config["mcp_servers.ace"].http_headers;
  const codex = await EvalAgent.connect({
    url: connection.url,
    bearer: connection.bearer,
    nativeInstructions: injected.developerInstructions,
    serverInstructions: false,
    headers,
  });
  return { claude, codex, instructions: injected.developerInstructions };
}

const Guide = z.object({
  tools: z.array(z.string()),
  how: z.string().optional(),
  schemas: z
    .array(z.object({ name: z.string(), inputSchema: z.object({ type: z.literal("object") }) }))
    .optional(),
});
const Found = z.object({
  matches: z.array(
    z.object({ name: z.string(), inputSchema: z.object({ type: z.literal("object") }).optional() }),
  ),
  how: z.string().optional(),
});

it("a Codex guide read returns the family's schemas and how to call them from exec", async () => {
  const { claude, codex } = await codexSession();
  const read = Guide.parse((await codex.call("guide", { topic: "ace-threads" })).data);
  expect(read.tools).toContain("thread_start");
  expect(read.schemas?.map((schema) => schema.name)).toEqual(read.tools);
  expect(read.how).toContain("tools.mcp__ace__<name>(args)");
  // Claude Code loads a deferred tool's schema through its own tool search: none inline.
  const deferred = Guide.parse((await claude.call("guide", { topic: "ace-threads" })).data);
  expect(deferred.schemas).toBeUndefined();
  expect(deferred.how).toBeUndefined();
  await codex.close();
});

it("a Codex search returns input schemas and the exec call form", async () => {
  const { codex } = await codexSession();
  const result = Found.parse(
    (await codex.call("tools_find", { query: "list my scheduled automations" })).data,
  );
  expect(result.matches[0]?.name).toBe("automations_list");
  expect(result.matches.every((match) => match.inputSchema !== undefined)).toBe(true);
  expect(result.how).toContain("tools.mcp__ace__<name>(args)");
  await codex.close();
});

/** `browser_{open,act}, context` → browser_open, browser_act, context. */
function expandNames(list: string): string[] {
  return list
    .split(/,\s*(?![^{]*\})/)
    .flatMap((entry) => {
      const group = /^([a-z]+)_\{([^}]+)\}$/.exec(entry.trim());
      return group
        ? (group[2] ?? "").split(",").map((rest) => `${group[1]}_${rest}`)
        : [entry.trim()];
    })
    .filter((name) => name && name !== "…");
}

it("Codex's developer instructions say how to reach ace from exec and name what it can call", async () => {
  const { codex, instructions } = await codexSession();
  expect(instructions).toContain("tools.mcp__ace__wait, not your own wait");
  expect(instructions).toContain('ALL_TOOLS.filter(t => t.name.startsWith("mcp__ace__"))');
  expect(instructions).toContain("tools.mcp__ace__tools_find({query})");
  const list = /ace tools here: (.+?)\.(?: |$)/m.exec(instructions)?.[1];
  if (!list) throw new Error("No tool list in Codex's instructions");
  const named = expandNames(list);
  const served = new Set(codex.tools.map((tool) => bareToolName(tool.name)));
  // Every name is one this session can call, and the list covers the whole catalogue.
  expect(named.filter((name) => !served.has(name))).toEqual([]);
  expect(new Set(named)).toEqual(served);
  expect(named).toEqual(expect.arrayContaining(["delegate", "wait", "thread_start", "guide"]));
  // Upfront, Codex pays only for these instructions: no schemas, no listed names.
  expect(tokens(list)).toBeLessThanOrEqual(300);
  expect(tokens(instructions)).toBeLessThanOrEqual(900);
  await codex.close();
});
