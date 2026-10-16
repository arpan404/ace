import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { builtinGuides } from "@ace/plugins";
import { ProviderKind } from "@ace/protocol";
import {
  aceInstructions,
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
/** Claude Code and Codex defer ace tools behind their own tool search; the rest load upfront. */
const deferring = new Set<ProviderKind>(["claude", "codex"]);
const toolName = /\b(?:ace|screen|device)_[a-z0-9_]+\b|\bdelegate_task\b/g;

let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
/**
 * A full-access thread with browser and computer use on: the largest catalogue it can see.
 * `full` is how a deferring client connects; `core` is how an upfront-loading client does.
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
  const registered = new Set([
    ...world.daemon.mcp.toolNames(),
    ...computerUseTools.map((tool) => tool.name),
  ]);
  return { full, core, registered };
}
/** The tools a provider's model has in context on every request. */
function upfront(provider: ProviderKind, full: EvalAgent, core: EvalAgent): ListedTool[] {
  return deferring.has(provider)
    ? full.tools.filter((tool) => tool["_meta"]?.["anthropic/alwaysLoad"] === true)
    : core.tools;
}
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
    expect(tokens(always), provider).toBeLessThanOrEqual(deferring.has(provider) ? 1_500 : 3_500);
  }
});

it("few enough ace tools are always on that each provider's native tools dominate", async () => {
  const { full, core } = await session();
  // The whole catalogue is far larger; only the entry points are always on.
  expect(full.tools.length).toBeGreaterThan(60);
  for (const provider of ProviderKind.options)
    expect(upfront(provider, full, core).length, provider).toBeLessThanOrEqual(
      deferring.has(provider) ? 2 : 12,
    );
});

it("a core-mode session gains a family's tools by reading its guide or using its entry point", async () => {
  const { core } = await session();
  expect(core.has("ace_threads_list")).toBe(false);
  // Every tool stays callable before it is listed: nothing is dropped, only deferred.
  expect((await core.call("ace_threads_list", {})).failed).toBe(false);
  const read = await core.call("ace_guide", { topic: "ace-threads" });
  expect(z.object({ tools: z.array(z.string()) }).parse(read.data).tools).toContain(
    "ace_threads_list",
  );
  await core.refreshTools();
  expect(core.has("ace_threads_list")).toBe(true);
  expect(core.has("ace_agents_status")).toBe(false);
  await core.call("delegate_task", {
    requestId: "open-agents",
    task: "Say hi",
    role: "say-hi opener",
    provider: "claude",
  });
  await core.refreshTools();
  expect(core.has("ace_agents_status")).toBe(true);
  await core.close();
});

it("the shipped skills cost under 600 tokens in a native skill listing", async () => {
  const guides = await builtinGuides();
  const listing = guides.map((guide) => `- ${guide.name}: ${guide.description}`).join("\n");
  expect(tokens(listing)).toBeLessThanOrEqual(600);
});

it("every shipped guide is reachable from the always-on guidance and serves through ace_guide", async () => {
  const { full } = await session();
  const guide = full.tools.find((tool) => tool.name === "ace_guide");
  if (!guide) throw new Error("ace_guide is not offered");
  // The always-on text names the ace guides; ace_guide's own description names the rest.
  expect(aceInstructions).toContain("ace_guide");
  for (const topic of guideTopics) expect(aceInstructions).toContain(topic);
  const pointers = `${aceInstructions}\n${guide.description ?? ""}`;
  for (const { name, body } of await builtinGuides()) {
    expect(pointers, name).toContain(name);
    const served = await full.call("ace_guide", { topic: name });
    expect(served.failed, name).toBe(false);
    expect(z.object({ guide: z.string() }).parse(served.data).guide).toBe(body);
  }
});

it("a wrong guide topic or an unavailable tool tells the agent what to call next", async () => {
  const { full, registered } = await session();
  const wrong = await full.call("ace_guide", { topic: "browser" });
  expect(wrong.failed).toBe(true);
  expect(wrong.text).toContain("invalid_arguments");
  expect(wrong.text).toContain("ace-browser");

  const missing = await full.call("ace_not_a_tool", {});
  expect(missing.failed).toBe(true);
  const failure = z.object({ code: z.string(), hint: z.string() }).parse(JSON.parse(missing.text));
  expect(failure.code).toBe("tool_unavailable");
  const next = [...failure.hint.matchAll(toolName)].map(([tool]) => tool);
  expect(next.length).toBeGreaterThan(0);
  for (const tool of next) expect(registered.has(tool), tool).toBe(true);
});
