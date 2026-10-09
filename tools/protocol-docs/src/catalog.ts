import * as entities from "@ace/protocol/entities";
import * as ids from "@ace/protocol/ids";
import * as notifications from "@ace/protocol/notifications";
import * as threadStatus from "@ace/protocol/thread-status";
import * as agentStatus from "@ace/protocol/agent-status";
import * as background from "@ace/protocol/background";
import * as agentControl from "@ace/protocol/agent-control";
import * as appDevices from "@ace/protocol/devices";
import * as transitions from "@ace/protocol/thread-transitions";
import * as handoffRead from "@ace/protocol/handoff-read";
import * as plugins from "@ace/protocol/plugins";
import * as preview from "@ace/protocol/preview";
import * as history from "@ace/protocol/history";
import * as pi from "@ace/protocol/pi";
import * as accounts from "@ace/protocol/accounts";
import * as queue from "@ace/protocol/queue";
import * as contextMeter from "@ace/protocol/context-meter";
import * as protocol from "@ace/protocol";
import * as forge from "@ace/protocol/forge";
import {
  builtinToolCatalog,
  agentControlToolCatalog,
  handoffToolCatalog,
  statusToolCatalog,
} from "@ace/mcp-server";
import { z } from "zod";
import type { SchemaEntry, ToolEntry } from "./model.ts";

export const protocolEntryPoints: ReadonlyMap<string, Record<string, unknown>> = new Map<
  string,
  Record<string, unknown>
>([
  [".", protocol],
  ["./ids", ids],
  ["./entities", entities],
  ["./notifications", notifications],
  ["./thread-status", threadStatus],
  ["./agent-status", agentStatus],
  ["./background", background],

  ["./queue", queue],
  ["./context-meter", contextMeter],
  ["./forge", forge],
  ["./plugins", plugins],
  ["./preview", preview],
  ["./history", history],
  ["./accounts", accounts],
  ["./agent-control", agentControl],
  ["./devices", appDevices],
  ["./thread-transitions", transitions],
  ["./handoff-read", handoffRead],
  ["./pi", pi],
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
  const tools = [
    ...builtinToolCatalog,
    ...agentControlToolCatalog,
    ...handoffToolCatalog,
    ...statusToolCatalog,
  ].map((tool): ToolEntry => {
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
