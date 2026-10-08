import { z } from "zod";
import type { OpenCodeClient } from "@opencode/client";
import type { Observe } from "./observation.ts";
import { object } from "./data.ts";
const commands = z.object({
  data: z
    .array(z.object({ name: z.string().max(256), description: z.string().max(2048).optional() }))
    .max(512),
});
/** Optional native metadata APIs, with one in-flight read and one pending update per surface. */
export function createExtensionCatalog(
  client: OpenCodeClient,
  cwd: string,
  emit: Observe,
  closed: () => boolean,
) {
  const location = { directory: cwd };
  const reads = new Map<string, () => Promise<unknown>>([
    ["command.list", () => client.command.list({ location })],
    ["skill.list", () => client.skill.list({ location })],
    ["agent.list", () => client.agent.list({ location })],
    ["plugin.list", () => client.plugin.list({ location })],
    ["mcp.list", () => client.mcp.list({ location })],
  ]);
  const running = new Map<string, Promise<boolean>>(),
    dirty = new Set<string>();
  function refresh(method: string): Promise<boolean> {
    const previous = running.get(method);
    if (previous) {
      dirty.add(method);
      return previous;
    }
    const read = reads.get(method);
    if (!read || closed()) return Promise.resolve(false);
    const work = (async () => {
      let success = false;
      do {
        dirty.delete(method);
        try {
          const reply = await read();
          if (closed()) return false;
          if (method === "command.list")
            emit("note", "commands.runtime", {
              sessionUpdate: "available_commands_update",
              availableCommands: commands.parse(reply).data,
            });
          else {
            const result = z.object({ data: z.array(z.unknown()).max(512) }).parse(reply);
            emit("note", "catalog.runtime", {
              method,
              cwd,
              result: {
                data: result.data.map((value) => {
                  const item = object(value);
                  return {
                    id: item.id,
                    description: item.description,
                    path: item.path,
                    hidden: item.hidden,
                    name:
                      method === "plugin.list"
                        ? (item.id ??
                          object(item.source).target ??
                          object(item.source).path ??
                          object(item.source).type)
                        : item.name,
                    enabled:
                      method === "plugin.list" ? object(item.state).status === "active" : undefined,
                    status: method === "mcp.list" ? object(item.status).status : undefined,
                  };
                }),
              },
            });
          }
          success = true;
        } catch {
          /* Preserve the last successful metadata on transient failures. */
        }
      } while (!closed() && dirty.has(method));
      return success;
    })().finally(() => {
      running.delete(method);
      dirty.delete(method);
    });
    running.set(method, work);
    return work;
  }
  return {
    async start() {
      if (!(await refresh("command.list")) && !closed())
        emit("note", "commands.runtime", {
          sessionUpdate: "available_commands_update",
          availableCommands: [],
        });
      await Promise.all(
        [...reads.keys()].filter((method) => method !== "command.list").map(refresh),
      );
    },
    changed(type: string) {
      if (["config.updated", "plugin.updated", "mcp.status.changed"].includes(type))
        for (const method of reads.keys()) void refresh(method);
      else if (["command.updated", "skill.updated", "agent.updated"].includes(type))
        void refresh(type.replace("updated", "list"));
    },
  };
}
