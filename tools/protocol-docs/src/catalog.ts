import * as transitions from "@ace/protocol/thread-transitions";
import * as plugins from "@ace/protocol/plugins";
import * as preview from "@ace/protocol/preview";
import * as history from "@ace/protocol/history";
import * as accounts from "@ace/protocol/accounts";
import * as protocol from "@ace/protocol";
import * as forge from "@ace/protocol/forge";
import { builtinToolCatalog } from "@ace/mcp-server";
import { z } from "zod";
import type { SchemaEntry, ToolEntry } from "./model.ts";

export const protocolEntryPoints: ReadonlyMap<string, Record<string, unknown>> = new Map<
  string,
  Record<string, unknown>
>([
  [".", protocol],
  ["./forge", forge],
  ["./plugins", plugins],
  ["./preview", preview],
  ["./history", history],
  ["./accounts", accounts],
  ["./thread-transitions", transitions],
]);

export function protocolCatalog(): { entries: SchemaEntry[]; tools: ToolEntry[] } {
  const exported = new Map<string, z.ZodType>();
  for (const namespace of protocolEntryPoints.values())
    for (const [name, schema] of Object.entries(namespace)) {
      if (!(schema instanceof z.ZodType)) continue;
      const existing = exported.get(name);
      if (existing && existing !== schema)
        throw new Error(`Schema ${name}: ambiguous public export`);
      exported.set(name, schema);
    }
  const entries: SchemaEntry[] = [...exported].map(([name, schema]) => ({ name, schema }));
  const tools = builtinToolCatalog.map((tool): ToolEntry => {
    const input = `${tool.name}.input`;
    const output = `${tool.name}.output`;
    entries.push(
      { name: input, schema: tool.input },
      { name: output, schema: tool.output, io: "output" },
    );
    return {
      name: tool.name,
      description: tool.description,
      capability: tool.capability,
      timeoutMs: tool.timeoutMs,
      input,
      output,
    };
  });
  return { entries: entries.toSorted((a, b) => a.name.localeCompare(b.name, "en")), tools };
}
