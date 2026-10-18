import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { builtinGuides } from "@ace/plugins";
import { ProviderKind } from "@ace/protocol";
import {
  aceInstructions,
  bareToolName,
  coreToolsHeader,
  developerInstructions,
  guideTopics,
} from "@ace/mcp-server";
import { computerUseTools } from "@ace/screen";
import { EvalAgent, type ListedTool } from "./evals/agent.ts";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

/**
 * What ace adds to every model request, per provider, as the real daemon serves it. Tokens are
 * estimated as characters / 4. Each budget fails a change that bloats the always-on surface:
 * guidance, the tools a client loads upfront, or the shipped skills' listing.
 */
const tokens = (text: string) => Math.ceil(text.length / 4);
const descriptor = ({ name, description, inputSchema }: ListedTool) =>
  JSON.stringify({ name, description, inputSchema });
/** Claude Code and Codex defer ace tools behind their own tool search. */
const deferring = new Set<ProviderKind>(["claude", "codex"]);
/** These load every listed tool upfront and reload on tools/list_changed: core mode. */
const reloading = new Set<ProviderKind>(["opencode", "pi"]);

let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
/**
 * A full-access thread with browser and computer use on: the largest catalogue it can see.
 * `full` is how a deferring or non-reloading client connects; `core` how a reloading one does.
 */
async function session() {
  world = await evalWorld({ browser: true });
  const { agent: full, connection } = await world.agent({});
  const core = await EvalAgent.connect({
    url: connection.url,
    bearer: connection.bearer,
    nativeInstructions: "",
    serverInstructions: true,
    headers: { [coreToolsHeader.name]: coreToolsHeader.value },
  });
  if (!world.daemon.mcp) throw new Error("Missing MCP server");
  const registered = new Set(
    [...world.daemon.mcp.toolNames(), ...computerUseTools.map((tool) => tool.name)].map(
      bareToolName,
    ),
  );
  return { full, core, registered };
}
/** The tools a provider's model has in context on every request. */
function upfront(provider: ProviderKind, full: EvalAgent, core: EvalAgent): ListedTool[] {
  if (deferring.has(provider))
    return full.tools.filter((tool) => tool["_meta"]?.["anthropic/alwaysLoad"] === true);
  return reloading.has(provider) ? core.tools : full.tools;
}
const bareNames = (tools: ListedTool[]) => tools.map((tool) => bareToolName(tool.name)).toSorted();
/** ace's guidance as one provider receives it: server instructions or its native channel. */
function guidance(provider: ProviderKind): string {
  const native = developerInstructions(provider);
  return native.includes(aceInstructions) ? native : `${aceInstructions}\n${native}`;
}

it("ace's always-on guidance stays under 300 tokens for every provider", () => {
  for (const provider of ProviderKind.options)
    expect(tokens(guidance(provider)), provider).toBeLessThanOrEqual(300);
});

it("each provider's per-request ace context stays within its budget", async () => {
  const { full, core } = await session();
  for (const provider of ProviderKind.options) {
    // A deferring client also lists every deferred tool's name.
    const names = deferring.has(provider) ? full.tools.map((tool) => tool.name) : [];
    const always = [
      guidance(provider),
      ...upfront(provider, full, core).map(descriptor),
      names.join(" "),
    ].join("\n");
    // A client that never reloads sees the whole catalogue, browser and computer use included.
    const budget = deferring.has(provider) ? 2_600 : reloading.has(provider) ? 3_500 : 16_000;
    expect(tokens(always), provider).toBeLessThanOrEqual(budget);
  }
});

it("only the entry points load upfront where a client defers or reloads its tool list", async () => {
  const { full, core } = await session();
  expect(bareNames(upfront("claude", full, core))).toEqual(
    ["browser_open", "context", "delegate", "guide", "html_render", "wait"].toSorted(),
  );
  expect(core.tools.length).toBeLessThanOrEqual(10);
  // ace's own agents, threads, knowledge and automations families stay small.
  const own = full.tools.filter(
    (tool) => !/^(?:browser|screen|device)_/.test(bareToolName(tool.name)),
  );
  expect(own.length).toBeLessThanOrEqual(28);
});

it("a core-mode session gains a family's tools by reading its guide or using its entry point", async () => {
  const { core } = await session();
  expect(core.has("threads_find")).toBe(false);
  const read = await core.call("guide", { topic: "ace-threads" });
  const family = z
    .object({ tools: z.array(z.string()), schemas: z.array(z.object({ name: z.string() })) })
    .parse(read.data);
  expect(family.tools).toContain("threads_find");
  // The guide's inline schemas let the agent call a family tool before its client reloads.
  expect(family.schemas.map((schema) => schema.name)).toEqual(family.tools);
  await core.refreshTools();
  expect(core.has("threads_find")).toBe(true);
  expect(core.has("agents_status")).toBe(false);
  await core.call("delegate", {
    tasks: [
      { requestId: "open-agents", task: "Say hi", role: "say-hi opener", provider: "claude" },
    ],
  });
  await core.refreshTools();
  expect(core.has("agents_status")).toBe(true);
  await core.close();
});

it("the shipped skills cost under 600 tokens in a native skill listing", async () => {
  const guides = await builtinGuides();
  const listing = guides.map((guide) => `- ${guide.name}: ${guide.description}`).join("\n");
  expect(tokens(listing)).toBeLessThanOrEqual(600);
});

it("every shipped guide is reachable from the always-on guidance and serves through guide", async () => {
  const { full } = await session();
  const guide = full.tools.find((tool) => tool.name === "guide");
  if (!guide) throw new Error("guide is not offered");
  for (const topic of guideTopics) expect(aceInstructions).toContain(topic);
  const pointers = `${aceInstructions}\n${guide.description ?? ""}`;
  for (const { name, body } of await builtinGuides()) {
    expect(pointers, name).toContain(name);
    const served = await full.call("guide", { topic: name });
    expect(served.failed, name).toBe(false);
    expect(z.object({ guide: z.string() }).parse(served.data).guide).toBe(body);
  }
});

it("a wrong guide topic or an unavailable tool tells the agent what to call next", async () => {
  const { full, registered } = await session();
  const wrong = await full.call("guide", { topic: "browser" });
  expect(wrong.failed).toBe(true);
  expect(wrong.text).toContain("invalid_arguments");
  expect(wrong.text).toContain("ace-browser");

  const missing = await full.call("not_a_tool", {});
  expect(missing.failed).toBe(true);
  const failure = z.object({ code: z.string(), hint: z.string() }).parse(JSON.parse(missing.text));
  expect(failure.code).toBe("tool_unavailable");
  const next = [...failure.hint.matchAll(/Call ([a-z_]+)|, or ([a-z_]+) for/g)].map(
    ([, first, second]) => first ?? second ?? "",
  );
  expect(next).toEqual(["context", "guide"]);
  for (const tool of next) expect(registered.has(tool), tool).toBe(true);
});
