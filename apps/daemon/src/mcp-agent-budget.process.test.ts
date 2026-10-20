import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { builtinGuides } from "@ace/plugins";
import { ProviderKind } from "@ace/protocol";
import {
  ToolRegistry,
  aceInstructions,
  bareToolName,
  coreToolsHeader,
  developerInstructions,
  nodeScheduler,
  staticToolsHeader,
  guideTopics,
  type SessionGuidance,
} from "@ace/mcp-server";
import { ComputerClient, computerToolkit, computerUseTools } from "@ace/screen";
import { EvalAgent, type ListedTool } from "./evals/agent.ts";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

/**
 * What ace adds to every model request, per provider, as the real daemon serves it. Tokens are
 * estimated as characters / 4. Each budget fails a change that bloats the always-on surface:
 * guidance and the session brief, the tools a client loads upfront, the shipped skills' listing
 * where the provider lists skills.
 */
const tokens = (text: string) => Math.ceil(text.length / 4);
const descriptor = ({ name, description, inputSchema }: ListedTool) =>
  JSON.stringify({ name, description, inputSchema });
/**
 * These defer ace tools and load upfront only the ones carrying their always-load key. Claude
 * lists the deferred names; Antigravity writes each deferred definition to a file and is counted
 * as listing the names too.
 */
const deferring = new Map<ProviderKind, string>([
  ["claude", "anthropic/alwaysLoad"],
  ["antigravity", "antigravity/alwaysLoad"],
]);
/**
 * Codex defers every ace tool and its code-mode models see no MCP schema or name: it pays only
 * for its developer instructions, which carry the names this session can call.
 */
const instructionsOnly = new Set<ProviderKind>(["codex"]);
/** These load every listed tool upfront and reload on tools/list_changed: core mode. */
const reloading = new Set<ProviderKind>(["opencode", "pi"]);
// The rest never reload: a fixed core list, with tools_call for everything else.
/**
 * Tokens each provider may spend on ace per request: guidance with the brief, upfront tools,
 * deferred names and the skill listing. Codex pays its developer text only.
 */
const budgets: Record<ProviderKind, number> = {
  claude: 2_650,
  codex: 1_150,
  opencode: 3_800,
  cursor: 3_800,
  antigravity: 2_100,
  acp: 3_200,
  pi: 3_800,
};

let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
/**
 * A full-access thread with browser and computer use on: the largest catalogue it can see.
 * `full` is how a deferring client connects, `core` a reloading one and `fixed` one that never
 * reloads.
 */
async function session() {
  world = await evalWorld({ browser: true });
  const { agent: full, connection } = await world.agent({});
  const connect = (header: { name: string; value: string }) =>
    EvalAgent.connect({
      url: connection.url,
      bearer: connection.bearer,
      nativeInstructions: "",
      serverInstructions: true,
      headers: { [header.name]: header.value },
    });
  const core = await connect(coreToolsHeader);
  const fixed = await connect(staticToolsHeader);
  if (!world.daemon.mcp) throw new Error("Missing MCP server");
  // The computer-use tools register only beside a screen helper: the macOS engine's, and the
  // session tools other platforms keep. Registration reads definitions; no helper starts.
  const computer = new ToolRegistry({ scheduler: nodeScheduler });
  const client: ComputerClient = Object.create(ComputerClient.prototype);
  computerToolkit(client).register(computer);
  const registered = new Set(
    [
      ...world.daemon.mcp.toolNames(),
      ...computerUseTools.map((tool) => tool.name),
      ...computer.names(),
    ].map(bareToolName),
  );
  // What the daemon knows at injection: the brief, roles, callable tools and access mode.
  const facts: SessionGuidance = connection.session?.() ?? {};
  return { full, core, fixed, registered, facts };
}
type Agents = Pick<Awaited<ReturnType<typeof session>>, "full" | "core" | "fixed">;
/** The tools a provider's model has in context on every request. */
function upfront(provider: ProviderKind, { full, core, fixed }: Agents): ListedTool[] {
  if (instructionsOnly.has(provider)) return [];
  const alwaysLoad = deferring.get(provider);
  if (alwaysLoad) return full.tools.filter((tool) => tool["_meta"]?.[alwaysLoad] === true);
  return reloading.has(provider) ? core.tools : fixed.tools;
}
const bareNames = (tools: ListedTool[]) => tools.map((tool) => bareToolName(tool.name)).toSorted();
/** ace's guidance as one provider receives it: server instructions or its native channel. */
function guidance(provider: ProviderKind, facts: SessionGuidance = {}): string {
  const native = developerInstructions(provider, facts);
  return native.includes(aceInstructions) ? native : `${aceInstructions}\n${native}`;
}
/** The shipped skills as a provider's native skill listing shows them. */
async function skillListing(): Promise<string> {
  const guides = await builtinGuides();
  return guides.map((guide) => `- ${guide.name}: ${guide.description}`).join("\n");
}

it("ace's shared guidance stays under 315 tokens and each provider's own lines stay short", () => {
  // Raised from 300 for one clause naming offshift (#899): it loads only on request, so the
  // instructions are the one place an agent learns it exists.
  expect(tokens(aceInstructions)).toBeLessThanOrEqual(315);
  // What varies by provider and listing (naming, how to reach an unlisted tool) is the provider's
  // own prefix, never the shared text. Codex's prefix carries its exec recipe instead of any
  // schema or name listing; mcp-codex-discovery.process.test.ts holds it under 900 tokens whole.
  for (const provider of ProviderKind.options.filter((kind) => kind !== "codex")) {
    const own = guidance(provider).replace(aceInstructions, "");
    expect(tokens(own), provider).toBeLessThanOrEqual(90);
  }
});

it("each provider's per-request ace context stays within its budget", async () => {
  const agents = await session();
  const skills = await skillListing();
  for (const provider of ProviderKind.options) {
    const text = guidance(provider, agents.facts);
    const tools = upfront(provider, agents);
    const always = [
      // Guidance with the session brief and roles; ACP's goes once, in its first prompt.
      text,
      ...tools.map(descriptor),
      // A deferring client also lists every deferred tool's name.
      deferring.has(provider) ? agents.full.tools.map((tool) => tool.name).join(" ") : "",
      // Where ace's guides are installed as skills, the provider lists them on every request.
      text.includes("installed as skills") ? skills : "",
    ].join("\n");
    // Every client starts small: deferred names, or the core list with tools_find and tools_call.
    // Each cap is the measured cost rounded up to the next 50, so a regression fails here.
    expect.soft(tokens(always), provider).toBeLessThanOrEqual(budgets[provider]);
  }
});

it("only the entry points and tools_find load upfront, whatever the client", async () => {
  const agents = await session();
  const { full, core, fixed } = agents;
  // browser_open and html_render are deferred for Claude; it loads them by exact name.
  expect(bareNames(upfront("claude", agents))).toEqual(
    ["context", "delegate", "guide", "tools_find", "wait"].toSorted(),
  );
  // Clients that load their list upfront keep them: they have no tool search to load them by.
  expect(core.has("browser_open")).toBe(true);
  expect(core.has("html_render")).toBe(true);
  // Raised from 11 to 12: core lists tools_call too, for a found tool its reload hasn't listed.
  expect(core.tools.length).toBeLessThanOrEqual(12);
  expect(core.has("tools_find")).toBe(true);
  expect(core.has("tools_call")).toBe(true);
  expect(fixed.tools.length).toBeLessThanOrEqual(12);
  // A client that never reloads lists what a reloading one starts with.
  expect(bareNames(fixed.tools)).toEqual(bareNames(core.tools));
  // ace's own agents, threads, knowledge and automations families stay small. Raised from 28 to
  // 30 for image_show (#991), projects_find (#994) and thread_fork (#1001), each a capability
  // with no existing tool to fold into. A deferring client pays only for their names, which
  // the per-request budget above counts; a core or static client never lists them upfront.
  // Raised to 31 for offshift (#899), a durable run record no thread tool can hold.
  const own = full.tools.filter(
    (tool) => !/^(?:browser|screen|sim)_/.test(bareToolName(tool.name)),
  );
  expect(own.length).toBeLessThanOrEqual(31);
});

it("a core-mode session gains a family's tools by reading its guide or using its entry point", async () => {
  const { core } = await session();
  expect(core.has("threads_find")).toBe(false);
  const read = await core.call("guide", { topic: "ace-threads" });
  const family = z
    .object({ tools: z.array(z.string()), schemas: z.unknown().optional() })
    .parse(read.data);
  expect(family.tools).toContain("threads_find");
  // The reload brings the family's schemas; the guide doesn't send them a second time.
  expect(family.schemas).toBeUndefined();
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

it("a core-mode session lists offshift only once an agent reads the offshift guide", async () => {
  const { core } = await session();
  expect(core.has("offshift")).toBe(false);
  await core.call("guide", { topic: "ace-threads" });
  await core.refreshTools();
  expect(core.has("offshift")).toBe(false);
  await core.call("guide", { topic: "offshift" });
  await core.refreshTools();
  expect(core.has("offshift")).toBe(true);
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
  const next = [...failure.hint.matchAll(/Call ([a-z_]+)|, or ([a-z_]+) with/g)].map(
    ([, first, second]) => first ?? second ?? "",
  );
  expect(next).toEqual(["tools_find", "context"]);
  for (const tool of next) expect(registered.has(tool), tool).toBe(true);
});
