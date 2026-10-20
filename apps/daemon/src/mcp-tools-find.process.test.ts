import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  acpInjection,
  coreToolsHeader,
  coreTools,
  cursorSdkInjection,
  staticToolsHeader,
} from "@ace/mcp-server";
import { detectChromium } from "@ace/browser";
import { EvalAgent } from "./evals/agent.ts";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

/**
 * `tools_find` and `tools_call` through the real daemon and a real MCP client, connected the way
 * each kind of provider connects.
 */
const chromium = await detectChromium();
let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});
const Found = z.object({
  matches: z.array(
    z.object({
      name: z.string(),
      purpose: z.string(),
      effect: z.string(),
      inputSchema: z.object({ type: z.literal("object") }).optional(),
    }),
  ),
  how: z.string().optional(),
  hint: z.string().optional(),
});
const found = (result: { data: unknown }) =>
  Found.parse(result.data).matches.map((match) => match.name);

async function connect(headers: Readonly<Record<string, string>>) {
  if (!world) throw new Error("No world");
  const { agent, connection } = await world.agent({});
  const other = await EvalAgent.connect({
    url: connection.url,
    bearer: connection.bearer,
    nativeInstructions: "",
    serverInstructions: true,
    headers,
  });
  return { full: agent, other };
}
/** How Cursor's SDK connects: its injection's own headers, credential aside. */
const cursorHeaders = () => {
  const { Authorization: _credential, ...headers } = cursorSdkInjection({
    url: "http://127.0.0.1:1/mcp",
    bearer: "0".repeat(64),
  }).mcpServers.ace.headers;
  return headers;
};

it("tools_find offers the computer-use tools for clicking in an app only while computer use is on", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  const query = { query: "click a button in an app" };
  const on = found(await agent.call("tools_find", query));
  expect(on.slice(0, 3)).toEqual(expect.arrayContaining(["screen_ui_act", "screen_input"]));
  await world.screen.enable(false);
  const off = await agent.call("tools_find", query);
  expect(off.failed, off.text).toBe(false);
  expect(found(off).filter((name) => name.startsWith("screen_"))).toEqual([]);
});

it.skipIf(!chromium)("tools_find ranks the browser's tab tool first for tab work", async () => {
  world = await evalWorld({ browser: true });
  const { agent } = await world.agent({});
  for (const query of ["open a new browser tab for a parallel agent", "list the open tabs"])
    expect(found(await agent.call("tools_find", { query }))[0], query).toBe("browser_tabs");
});

it("tools_find answers a query nothing matches with where to look next", async () => {
  world = await evalWorld({ browser: false });
  const { agent } = await world.agent({});
  const result = Found.parse((await agent.call("tools_find", { query: "zzzz qqqq" })).data);
  expect(result.matches).toEqual([]);
  expect(result.hint).toContain("guide");
});

it("Cursor and ACP agents start with the core tools plus tools_find and tools_call", async () => {
  world = await evalWorld({ browser: true });
  const { full, other: cursor } = await connect(cursorHeaders());
  // The core tools this thread is offered (a root thread whose provider asks for itself has no
  // `ask`), and the two ways to the rest.
  const offeredCore = full.tools
    .map((tool) => tool.name)
    .filter((name) => coreTools.has(name) || name === "tools_find");
  const expected = [...offeredCore, "tools_call"].toSorted();
  expect(offeredCore).toContain("tools_find");
  expect(cursor.tools.map((tool) => tool.name).toSorted()).toEqual(expected);
  expect(cursor.tools.length).toBeLessThanOrEqual(12);
  expect(full.tools.length).toBeGreaterThan(expected.length * 3);
  // ACP's HTTP injection asks for the same listing.
  const acp = acpInjection({ url: "http://127.0.0.1:1/mcp", bearer: "0".repeat(64) });
  expect(acp.mcpServers[0]?.headers).toContainEqual(staticToolsHeader);
  // tools_call says it can reach destructive tools, so a client that gates those asks first.
  expect(cursor.tools.find((tool) => tool.name === "tools_call")?.annotations).toMatchObject({
    destructiveHint: true,
    readOnlyHint: false,
  });
  await cursor.close();
});

it("tools_call runs a read-only tool and returns exactly what calling it directly returns", async () => {
  world = await evalWorld({ browser: false });
  const { full, other: cursor } = await connect(cursorHeaders());
  const direct = await full.call("automations_list", {});
  const dispatched = await cursor.call("tools_call", { name: "automations_list", arguments: {} });
  expect(dispatched.failed, dispatched.text).toBe(false);
  expect(dispatched.data).toEqual(direct.data);
  expect(dispatched.data).toMatchObject({ ok: true, data: { automations: [] } });
  await cursor.close();
});

it("tools_call refuses arguments the target's schema refuses, with the same error as a direct call", async () => {
  world = await evalWorld({ browser: false });
  const { full, other: cursor } = await connect(cursorHeaders());
  const bad = { id: "nightly", title: "Nightly", prompt: "Lint", bogus: true };
  const direct = await full.call("automation_put", bad);
  const dispatched = await cursor.call("tools_call", { name: "automation_put", arguments: bad });
  expect(direct.failed).toBe(true);
  expect(dispatched.failed).toBe(true);
  expect(dispatched.text).toBe(direct.text);
  expect(direct.text).toContain("invalid_arguments");
  await cursor.close();
});

it("tools_call refuses to run tools_call or tools_find, and points an unknown name at tools_find", async () => {
  world = await evalWorld({ browser: false });
  const { other: cursor } = await connect(cursorHeaders());
  for (const name of ["tools_call", "tools_find", "mcp__ace__tools_call"]) {
    const nested = await cursor.call("tools_call", { name, arguments: { query: "x" } });
    expect(nested.failed, name).toBe(true);
    expect(nested.text, name).toContain("invalid_arguments");
  }
  const unknown = await cursor.call("tools_call", { name: "no_such_tool", arguments: {} });
  expect(unknown.failed).toBe(true);
  expect(unknown.text).toContain("tool_unavailable");
  expect(unknown.text).toContain("tools_find");
  await cursor.close();
});

it("tools_call is offered to every client whose list lacks tools, never to one listing them all", async () => {
  world = await evalWorld({ browser: false });
  const { full, other: core } = await connect({ [coreToolsHeader.name]: coreToolsHeader.value });
  expect(full.has("tools_find")).toBe(true);
  expect(full.has("tools_call")).toBe(false);
  const refused = await full.call("tools_call", { name: "automations_list", arguments: {} });
  expect(refused.failed).toBe(true);
  expect(refused.text).toContain("tool_unavailable");
  // A core client's list grows a step late: tools_call reaches a tool it hasn't listed yet.
  expect(core.has("tools_call")).toBe(true);
  expect(core.has("automations_list")).toBe(false);
  const early = await core.call("tools_call", { name: "automations_list", arguments: {} });
  expect(early.failed, early.text).toBe(false);
  expect(early.data).toEqual((await full.call("automations_list", {})).data);
  // Claude Code defers ace's tools but keeps tools_find loaded.
  expect(full.tools.find((tool) => tool.name === "tools_find")?.["_meta"]).toMatchObject({
    "anthropic/alwaysLoad": true,
  });
  await core.close();
});

it("a core-mode search adds the found family to the list and tells the agent how to call it", async () => {
  world = await evalWorld({ browser: false });
  const { other: core } = await connect({ [coreToolsHeader.name]: coreToolsHeader.value });
  expect(core.has("automations_list")).toBe(false);
  const result = Found.parse(
    (await core.call("tools_find", { query: "list my scheduled automations" })).data,
  );
  expect(result.matches[0]?.name).toBe("automations_list");
  expect(result.how).toContain("tool list");
  expect(result.how).toContain("tools_call");
  // The reload brings each found tool's schema: the search doesn't pay for it twice.
  expect(result.matches.every((match) => match.inputSchema === undefined)).toBe(true);
  await core.refreshTools();
  expect(core.has("automations_list")).toBe(true);
  await core.close();
});

it("a dispatched destructive call is approved as the tool it runs", async () => {
  world = await evalWorld({ browser: false });
  const mcp = world.daemon.mcp;
  if (!mcp) throw new Error("Missing MCP server");
  const args = { id: "nightly-lint" };
  const direct = mcp.action("automation_remove", args);
  expect(direct).toMatchObject({ tool: "automation_remove", origin: "ace" });
  expect(mcp.action("tools_call", { name: "automation_remove", arguments: args })).toEqual(direct);
  expect(
    mcp.action("mcp__ace__tools_call", { name: "automation_remove", arguments: args }),
  ).toEqual(direct);
});
