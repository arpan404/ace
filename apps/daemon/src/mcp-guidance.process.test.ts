import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  MachineMessageResult,
  MachineSummary,
  MessageArrival,
  ProviderKind,
  Transfer,
  WaitStatus,
  WatchedState,
} from "@ace/protocol";
import {
  PublicToolCode,
  ToolRegistry,
  aceInstructions,
  bareToolName,
  codexInjection,
  developerInstructions,
  guideTopics,
  nodeScheduler,
} from "@ace/mcp-server";
import { DevicesService, devicesToolkit } from "@ace/devices";
import { builtinGuides } from "@ace/plugins";
import { ComputerClient, computerToolkit, computerUseTools } from "@ace/screen";
import type { ListedTool } from "./evals/agent.ts";
import { evalWorld, type EvalWorld } from "./evals/world.ts";

let world: EvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** The simulator tools, which register only when the devices service runs on a Mac. */
function simTools(): string[] {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  // Registration only reads definitions; the service is never called.
  const service: DevicesService = Object.create(DevicesService.prototype);
  devicesToolkit(service).register(registry);
  return registry.names();
}

/** The macOS computer-use tools, which register only when the daemon runs on a Mac. */
function computerTools(): string[] {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  // Registration only reads definitions; the helper is never started.
  const client: ComputerClient = Object.create(ComputerClient.prototype);
  computerToolkit(client).register(registry);
  return registry.names();
}

/**
 * Every tool the daemon serves to a full-access thread, plus the fixed computer-use catalogues
 * (macOS and other platforms) and the simulator catalogue.
 */
async function served() {
  world = await evalWorld({ browser: true });
  const { agent } = await world.agent({});
  const tools: ListedTool[] = agent.tools;
  const names = new Set(
    [
      ...tools.map((tool) => tool.name),
      ...computerUseTools.map((tool) => tool.name),
      ...computerTools(),
      ...simTools(),
    ].map(bareToolName),
  );
  return { tools, names };
}

/**
 * The error codes the macOS computer-use helper throws. The computer-use guide quotes some,
 * such as screen_locked, and they read like tool names.
 */
function helperErrorCodes(): string[] {
  const dir = fileURLToPath(new URL("../../../native/screen-helper/", import.meta.url));
  const codes = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".swift")))
    for (const [, code] of readFileSync(join(dir, file), "utf8").matchAll(/CUError\("([a-z_]+)"/g))
      if (code) codes.add(code);
  return [...codes];
}

/** Property names and string enum values in a JSON schema: the vocabulary a guide may quote. */
function vocabulary(node: unknown, into: Set<string>): Set<string> {
  const record = z.record(z.string(), z.unknown()).safeParse(node).data;
  if (record) {
    const properties = z.record(z.string(), z.unknown()).safeParse(record["properties"]).data;
    for (const [name, child] of Object.entries(properties ?? {})) {
      into.add(name);
      vocabulary(child, into);
    }
    for (const key of ["const", "default"])
      if (typeof record[key] === "string") into.add(String(record[key]));
    for (const value of z.array(z.unknown()).catch([]).parse(record["enum"]))
      if (typeof value === "string") into.add(value);
    for (const [key, value] of Object.entries(record))
      if (key !== "properties" && typeof value === "object") vocabulary(value, into);
  } else if (Array.isArray(node)) for (const child of node) vocabulary(child, into);
  return into;
}

/**
 * The tools an instruction text tells the agent to call: each "- situation: tool, then tool"
 * line, and the "guide with topic" pointer.
 */
function instructedTools(text: string): string[] {
  const tools: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("- ")) {
      const action = line.slice(line.lastIndexOf(": ") + 2);
      for (const [, name] of action.matchAll(/(?:^|then )([a-z]+(?:_[a-z]+)*)/g))
        if (name) tools.push(name);
    }
    const pointer = /\b([a-z]+) with topic\b/.exec(line)?.[1];
    if (pointer) tools.push(pointer);
    // "Not sure which ace tool fits? tools_find with what you want to do."
    const search = /\? ([a-z]+(?:_[a-z]+)*) with\b/.exec(line)?.[1];
    if (search) tools.push(search);
  }
  return tools;
}

it("every tool the instructions name is served, in every provider's guidance", async () => {
  const { names } = await served();
  expect(instructedTools(aceInstructions).length).toBeGreaterThanOrEqual(9);
  expect(instructedTools(aceInstructions)).toContain("tools_find");
  for (const text of [
    aceInstructions,
    ...ProviderKind.options.map((p) => developerInstructions(p)),
  ])
    for (const name of instructedTools(text))
      expect(names.has(bareToolName(name)), `${name} in instructions`).toBe(true);
  // Each family the instructions point to is a guide topic the guide tool accepts.
  const guides = new Set((await builtinGuides()).map((guide) => guide.name));
  for (const topic of guideTopics) expect(guides.has(topic), topic).toBe(true);
});

it("a read-only thread's guidance names ace tools the server serves as read-only", async () => {
  world = await evalWorld({ browser: false });
  const { agent, connection } = await world.agent({ access: "read-only" });
  const text = codexInjection(connection).developerInstructions;
  const named = /ace's read tools \(([^)]+)\) still work/.exec(text)?.[1]?.split(", ") ?? [];
  expect(named).toEqual(expect.arrayContaining(["context", "thread_read", "wait"]));
  for (const name of named)
    expect(
      agent.tools.find((tool) => bareToolName(tool.name) === name)?.annotations,
      name,
    ).toMatchObject({ readOnlyHint: true });
});

it("the agents and threads guides quote only served tools, their fields and values", async () => {
  const { tools, names } = await served();
  const fields = new Set<string>();
  // A guide may quote what a tool takes and what it returns.
  for (const tool of tools) {
    vocabulary(tool.inputSchema, fields);
    vocabulary(tool.outputSchema, fields);
  }
  const known = new Set<string>([
    ...names,
    ...fields,
    ...WaitStatus.options,
    ...WatchedState.options,
    ...PublicToolCode.options,
    ...guideTopics,
    // Control tools advertise no output schema, so the results the guides describe come from
    // the protocol: agent_message's arrival, a machines entry, and a transfer's id.
    ...Object.keys(MachineMessageResult.shape),
    ...MessageArrival.options,
    ...Object.keys(MachineSummary.shape),
    ...Object.keys(Transfer.shape),
    // Result fields the guides tell the agent to page with; results are advertised as envelopes.
    "itemsBefore",
    "nextOffset",
  ]);
  const guides = await builtinGuides();
  for (const topic of ["ace-agents", "ace-threads"]) {
    const body = guides.find((guide) => guide.name === topic)?.body ?? "";
    // Code spans that read like identifiers: tool names, fields and enum values. Capitalised
    // spans are example values (a role such as `Implementer`), not names to call.
    const quoted = [...body.matchAll(/`([a-z][a-zA-Z0-9_]*)(?: \{[^`]*\})?`/g)].map(
      ([, name]) => name ?? "",
    );
    expect(quoted.length, topic).toBeGreaterThan(10);
    const unknown = quoted.filter((name) => !known.has(name));
    expect(unknown, topic).toEqual([]);
  }
});

it("every guide names only tools the server serves, in any family", async () => {
  const { names } = await served();
  const known = new Set<string>([...names, ...PublicToolCode.options, ...helperErrorCodes()]);
  // Family-prefixed words and ace_-namespaced words read as tool names; a retired name such as
  // ace_machines, delegate_task or device_start must not survive in any guide or skill.
  const toolShaped = /\b(?:(?:browser|screen|sim|device|ace)_[a-z0-9_]+|delegate_task)\b/g;
  const guides = await builtinGuides();
  expect(guides.length).toBeGreaterThan(5);
  for (const guide of guides) {
    const unknown = [...guide.body.matchAll(toolShaped)]
      .map(([name]) => name)
      .filter((name) => !known.has(name) && !known.has(bareToolName(name)));
    expect(unknown, guide.name).toEqual([]);
  }
});

it("the agents guide quotes the batch limit the delegate schema enforces", async () => {
  const { tools } = await served();
  const delegate = tools.find((tool) => bareToolName(tool.name) === "delegate");
  const limit = z
    .object({ properties: z.object({ tasks: z.object({ maxItems: z.number() }) }) })
    .parse(delegate?.inputSchema).properties.tasks.maxItems;
  const body = (await builtinGuides()).find((guide) => guide.name === "ace-agents")?.body ?? "";
  expect(body).toContain(`up to ${limit} tasks`);
  expect(delegate?.description).toContain(`1 to ${limit} tasks`);
});
