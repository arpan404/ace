import { afterEach, expect, it } from "vitest";
import { builtinGuides } from "@ace/plugins";
import {
  aceInstructions,
  bareToolName,
  claudeAceServer,
  coreToolsHeader,
  developerInstructions,
} from "@ace/mcp-server";
import { EvalAgent, type ListedTool } from "./evals/agent.ts";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

/**
 * What ace's advertised tool definitions cost a client that loads them all, as the real daemon
 * serves them. The per-provider caps live in mcp-agent-budget.process.test.ts; these hold the
 * catalogue itself, which a client without a tool search (Claude Code with ENABLE_TOOL_SEARCH
 * off, an old model, a gateway that refuses deferral) would pay on every request if it ever
 * listed every tool. Tokens are estimated as characters / 4.
 *
 * Each cap is the measured cost rounded up to the next 50 tokens. To raise one, measure the
 * new cost, say in a comment beside the cap what was added and why no existing tool could carry
 * it, and set the cap to the new measurement rounded up to the next 50.
 */
const tokens = (text: string) => Math.ceil(text.length / 4);
const descriptor = ({ name, description, inputSchema }: ListedTool) =>
  JSON.stringify({ name, description, inputSchema });

/** Every tool a full-access thread with the browser and computer use on is offered. */
const catalogueCap = 10_050;
/** Any one tool's advertised definition: its name, description and input schema. */
const perToolCap = 650;
/**
 * A Claude session without tool search: guidance with the brief, the core tools in full, and the
 * skill listing. It never pays for the full catalogue (claude-tool-search.ts).
 */
const claudeWithoutToolSearchCap = 2_650;

let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
async function session() {
  world = await evalWorld({ browser: true });
  const { agent: full, connection } = await world.agent({});
  return { full, connection };
}

it(`ace's whole advertised catalogue stays under ${catalogueCap} tokens`, async () => {
  const { full } = await session();
  expect(tokens(full.tools.map(descriptor).join("\n"))).toBeLessThanOrEqual(catalogueCap);
});

it(`no single ace tool's advertised definition exceeds ${perToolCap} tokens`, async () => {
  const { full } = await session();
  const over = full.tools
    .map((tool) => ({ tool: bareToolName(tool.name), tokens: tokens(descriptor(tool)) }))
    .filter((entry) => entry.tokens > perToolCap);
  expect(over).toEqual([]);
});

it(`a Claude session without tool search pays at most ${claudeWithoutToolSearchCap} tokens of ace context per request`, async () => {
  const { connection } = await session();
  // Connect exactly as the adapter connects a Claude session it found without tool search.
  const server = claudeAceServer(connection, "core");
  expect(server.headers).toHaveProperty(coreToolsHeader.name, coreToolsHeader.value);
  const agent = await EvalAgent.connect({
    url: server.url,
    bearer: connection.bearer,
    nativeInstructions: "",
    serverInstructions: true,
    headers: server.headers,
  });
  try {
    const guides = await builtinGuides();
    const always = [
      aceInstructions,
      developerInstructions("claude", { ...connection.session?.(), listing: "core" }),
      ...agent.tools.map(descriptor),
      guides.map((guide) => `- ${guide.name}: ${guide.description}`).join("\n"),
    ].join("\n");
    expect(tokens(always)).toBeLessThanOrEqual(claudeWithoutToolSearchCap);
  } finally {
    await agent.close();
  }
});
