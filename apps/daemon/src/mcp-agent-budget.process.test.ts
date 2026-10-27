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
 * Cursor's MCP meta tool shows the model each listed tool's name and the server's instructions,
 * never a schema: the model reads one with GetMcpTools and calls it with CallMcpTool. Nothing
 * loads upfront, so it pays only for the names.
 */
const namesOnly = new Set<ProviderKind>(["cursor"]);
/**
 * Codex defers every ace tool on a model with tool search (every model in its catalog) and its
 * code-mode models see no MCP schema or name: it pays only for its developer instructions, which
 * carry the names this session can call. Models without search are budgeted below.
 */
const instructionsOnly = new Set<ProviderKind>(["codex"]);
/** These load every listed tool upfront and reload on tools/list_changed: core mode. */
const reloading = new Set<ProviderKind>(["opencode", "pi"]);
// Generic ACP and its stdio bridge never reload: a fixed core list, tools_call for the rest.
/**
 * Tokens each provider may spend on ace per request: guidance with the brief, upfront tools,
 * deferred names and the skill listing. Codex pays its developer text only.
 */
const budgets: Record<ProviderKind, number> = {
  // Lowered from 2_650 when schemas were compacted and Claude preloaded only context and delegate.
  claude: 1_550,
  codex: 1_150,
  opencode: 2_650,
  // Lowered from 2_900: Cursor's MCP meta tool shows names only, so it pays for every tool's name
  // and no schema (ADR 0086, 2026-10-27).
  cursor: 1_150,
  antigravity: 1_600,
  acp: 2_350,
  pi: 2_900,
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
  if (instructionsOnly.has(provider) || namesOnly.has(provider)) return [];
  const alwaysLoad = deferring.get(provider);
  if (alwaysLoad) return full.tools.filter((tool) => tool["_meta"]?.[alwaysLoad] === true);
  return reloading.has(provider) ? core.tools : fixed.tools;
}
/** The names a deferring client lists beside what it loads; Cursor separates them by commas. */
function listedNames(provider: ProviderKind, { full }: Agents): string {
  if (!deferring.has(provider) && !namesOnly.has(provider)) return "";
  return full.tools.map((tool) => tool.name).join(namesOnly.has(provider) ? ", " : " ");
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

it("ace's shared guidance stays under 250 tokens and each provider's own lines stay short", () => {
  expect(tokens(aceInstructions)).toBeLessThanOrEqual(250);
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
      listedNames(provider, agents),
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
  // Claude searches deferred tools itself and reads the guides as skills: only context and
  // delegate load upfront. Antigravity has neither, so it keeps wait, guide and tools_find too.
  expect(bareNames(upfront("claude", agents))).toEqual(["context", "delegate"]);
  expect(bareNames(upfront("antigravity", agents))).toEqual(
    ["context", "delegate", "guide", "tools_find", "wait"].toSorted(),
  );
  // Cursor lists every tool by name and calls each directly through its own CallMcpTool, so ace
  // never offers it tools_call.
  expect(upfront("cursor", agents)).toEqual([]);
  expect(full.has("thread_start")).toBe(true);
  expect(full.has("tools_call")).toBe(false);
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
  // Raised to 31 for offshift (#899), a durable run record no thread tool can hold. Raised to 33
  // for transfer (ADR 0101), moving work to another machine, which no delegate or thread tool
  // can do; the base it landed on already listed 32.
  const own = full.tools.filter(
    (tool) => !/^(?:browser|screen|sim)_/.test(bareToolName(tool.name)),
  );
  expect(own.length).toBeLessThanOrEqual(33);
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

it("the shipped skills cost under 350 tokens in a native skill listing", async () => {
  const guides = await builtinGuides();
  const listing = guides.map((guide) => `- ${guide.name}: ${guide.description}`).join("\n");
  expect(tokens(listing)).toBeLessThanOrEqual(350);
});

it("every shipped guide is reachable from the always-on guidance and serves through guide", async () => {
  const { full } = await session();
  const guide = full.tools.find((tool) => tool.name === "guide");
  if (!guide) throw new Error("guide is not offered");
  for (const topic of guideTopics) expect(aceInstructions).toContain(topic);
  // The guide tool's topic enum names every guide once; the shared text names the families.
  const pointers = `${aceInstructions}\n${JSON.stringify(guide.inputSchema)}`;
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

it.runIf(process.platform === "win32")(
  "Windows: each provider's per-request ace context stays within its budget with the guidance the server serves",
  async () => {
    const agents = await session();
    const skills = await skillListing();
    // Windows' computer-use engine lists screen_open_app, so the server's guidance names it
    // instead of macOS's screen_state; count the copy the server serves, once.
    const served = agents.full.serverInstructions;
    for (const provider of ProviderKind.options) {
      const native = developerInstructions(provider, agents.facts);
      // Providers that skip server instructions carry their own copy in the native channel.
      const own = native.includes(served.split("\n")[0] ?? served);
      const text = own ? native : `${served}\n${native}`;
      const tools = upfront(provider, agents);
      const always = [
        text,
        ...tools.map(descriptor),
        listedNames(provider, agents),
        text.includes("installed as skills") ? skills : "",
      ].join("\n");
      expect.soft(tokens(always), provider).toBeLessThanOrEqual(budgets[provider]);
    }
  },
);

/**
 * Codex loads every listed tool upfront where the model has no tool search (a model outside its
 * catalog, Bedrock Runtime) and never reloads, so those sessions connect with the fixed list.
 * Listing every tool there cost the whole catalogue, about 10,050 tokens, on every request.
 */
const codexWithoutToolSearchCap = 3_100;

it(`a Codex session without tool search pays at most ${codexWithoutToolSearchCap} tokens of ace context per request`, async () => {
  const agents = await session();
  const text = guidance("codex", { ...agents.facts, listing: "static" });
  const always = [
    text,
    ...agents.fixed.tools.map(descriptor),
    text.includes("installed as skills") ? await skillListing() : "",
  ].join("\n");
  expect(text).toContain("tools_call {name, arguments}");
  expect(tokens(always)).toBeLessThanOrEqual(codexWithoutToolSearchCap);
});

it("Claude's per-request ace context stays under 1,550 tokens", async () => {
  const agents = await session();
  const text = guidance("claude", agents.facts);
  // Guidance with the brief, the two always-loaded schemas, every deferred name and the skills.
  const always = [
    text,
    ...upfront("claude", agents).map(descriptor),
    agents.full.tools.map((tool) => tool.name).join(" "),
    await skillListing(),
  ].join("\n");
  expect(text).toContain("installed as skills");
  expect(tokens(always)).toBeLessThanOrEqual(budgets.claude);
});
