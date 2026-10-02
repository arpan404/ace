import { z } from "zod";
import { PluginName } from "@ace/protocol/plugins";
import { Hook, McpServer, normalizePath, parseJson } from "./manifest.ts";
const object = z.record(z.string(), z.unknown());

/** Every traversal and output is charged before expansion, including repeated aliases. */
function expansion(files: Record<string, string>, consume: (value: unknown) => void) {
  const active = new Set<string>();
  let visits = 0;
  let outputs = 0;
  function visit(value: unknown, depth = 0): void {
    if (++visits > 2048 || depth > 32) throw new Error("Import expansion limit");
    if (typeof value === "string") {
      const path = normalizePath(value);
      if (active.has(path)) throw new Error("Cyclic component reference");
      const content = files[path];
      if (content === undefined) throw new Error(`Component file missing: ${path}`);
      active.add(path);
      try {
        visit(parseJson(content), depth + 1);
      } finally {
        active.delete(path);
      }
    } else if (Array.isArray(value)) {
      if (value.length > 256) throw new Error("Import expansion limit");
      for (const entry of value) visit(entry, depth + 1);
    } else consume(value);
  }
  return {
    visit,
    output() {
      if (++outputs > 256) throw new Error("Import expansion limit");
    },
  };
}
export function mcpReader(files: Record<string, string>, portable: boolean) {
  const mcpServers: Record<string, z.infer<typeof McpServer>> = Object.create(null);
  const budget = expansion(files, consumeMcp);
  function consumeMcp(value: unknown) {
    const outer = object.parse(value);
    const servers = object.parse(outer.mcpServers ?? outer);
    for (const [name, entry] of Object.entries(servers)) {
      const server = object.parse(entry);
      const type =
        server.type === "streamable-http"
          ? "http"
          : (server.type ?? (server.command ? "stdio" : "http"));
      if (typeof server.command === "string" && server.command.startsWith("./"))
        normalizePath(server.command);
      budget.output();
      mcpServers[PluginName.parse(name)] = McpServer.parse({
        ...server,
        type,
        ...(portable && type === "stdio" ? { cwd: server.cwd ?? "${PLUGIN_ROOT}" } : {}),
      });
    }
  }
  return { mcpServers, readMcp: budget.visit };
}
export function hookReader(files: Record<string, string>, unsupported: string[]) {
  const hooks: z.infer<typeof Hook>[] = [];
  const report = (reason: string) => {
    if (unsupported.length >= 512) throw new Error("Import diagnostic limit");
    unsupported.push(reason);
  };
  const budget = expansion(files, consumeHooks);
  function consumeHooks(value: unknown) {
    const outer = object.parse(value);
    const events = object.parse(outer.hooks ?? outer);
    for (const [event, entries] of Object.entries(events)) {
      for (const group of z.array(object).max(256).parse(entries)) {
        const handlers =
          group.hooks === undefined ? [group] : z.array(object).max(256).parse(group.hooks);
        for (const handler of handlers) {
          budget.output();
          if (handler.type !== undefined && handler.type !== "command") {
            report(`Unsupported ${event} hook type: ${String(handler.type)}`);
            continue;
          }
          for (const key of Object.keys(handler))
            if (!["type", "command", "matcher"].includes(key))
              report(`Unsupported ${event} hook option: ${key}`);
          hooks.push(
            Hook.parse({
              event,
              command: handler.command,
              ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
            }),
          );
        }
      }
    }
  }
  return { hooks, readHooks: budget.visit };
}
