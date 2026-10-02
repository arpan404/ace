import * as protocol from "@ace/protocol";
import { builtinToolCatalog } from "@ace/mcp-server";
import { z } from "zod";
import type { SchemaEntry, ToolEntry } from "./model.ts";

export function protocolCatalog(): { entries: SchemaEntry[]; tools: ToolEntry[] } {
  const entries: SchemaEntry[] = Object.entries(protocol).flatMap(([name, schema]) =>
    schema instanceof z.ZodType ? [{ name, schema }] : [],
  );
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
