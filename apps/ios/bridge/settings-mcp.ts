import type { ClientCore } from "@ace/client";
import { McpSources, ProviderKind } from "@ace/protocol";
import {
  checkMcpServer,
  mcpServersNote,
  mcpServerWord,
  providerHasMcpServers,
  providerNames,
} from "@ace/ui-core";
import { z } from "zod";

/*
 * A provider's own MCP servers on the phone, as its latest live session reports them: each
 * server's state in one word, Reconnect, Turn off and Turn on, and Add MCP server for a URL or a
 * command with its arguments. These are the provider's servers, so its own configuration and
 * permissions decide; ace adds no approval of its own. Swift draws.
 */

const draft = {
  name: z.string().max(256),
  transport: z.enum(["command", "http"]),
  address: z.string().max(8192),
};
export const McpScreenRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("mcp.screen"), provider: ProviderKind }),
  z.object({
    type: z.literal("mcp.screen.control"),
    provider: ProviderKind,
    name: z.string().min(1).max(256),
    action: z.enum(["reconnect", "enable", "disable"]),
  }),
  z.object({
    type: z.literal("mcp.screen.check"),
    taken: z.array(z.string().max(256)).max(512).default([]),
    ...draft,
  }),
  z.object({
    type: z.literal("mcp.screen.add"),
    provider: ProviderKind,
    taken: z.array(z.string().max(256)).max(512).default([]),
    ...draft,
  }),
]);
export type McpScreenRequest = z.infer<typeof McpScreenRequest>;

export interface McpServerRow {
  name: string;
  /** "Connected", "Off", "Not signed in"; null when the provider doesn't say. */
  word: string | null;
  off: boolean;
  failed: boolean;
}

export interface McpScreen {
  /** The provider hands ace its MCP controls at all. */
  managed: boolean;
  servers: McpServerRow[];
  canAdd: boolean;
  note: string | null;
}

export function mcpScreen(provider: ProviderKind, sources: McpSources): McpScreen {
  return {
    managed: true,
    servers: sources.servers.map((server) => ({
      name: server.name,
      word: mcpServerWord(server.status) ?? null,
      off: server.status === "disabled",
      failed: server.status === "failed",
    })),
    canAdd: sources.canAdd,
    note: mcpServersNote(sources, providerNames[provider]) ?? null,
  };
}

const verbs = { reconnect: "reconnect", enable: "turn on", disable: "turn off" } as const;

type Owner = Pick<ClientCore, "request">;
type Reply = { ok: true; [key: string]: unknown } | { ok: false; problem: string };

export async function answerMcpScreen(
  owner: Owner,
  request: McpScreenRequest,
  signal: AbortSignal,
): Promise<Reply> {
  if (request.type === "mcp.screen.check") {
    const check = checkMcpServer(request, request.taken);
    return check.ok
      ? { ok: true, field: null, problem: null }
      : { ok: true, field: check.field, problem: check.problem };
  }
  const options = { signal, timeoutMs: 20_000 };
  const name = providerNames[request.provider];
  if (request.type === "mcp.screen") {
    if (!providerHasMcpServers(request.provider))
      return {
        ok: true,
        screen: { managed: false, servers: [], canAdd: false, note: null } satisfies McpScreen,
      };
    try {
      const reply = await owner.request(
        { type: "mcp.provider.sources", provider: request.provider },
        options,
      );
      const sources = McpSources.safeParse(reply.result);
      if (!sources.success) throw new Error("Unexpected MCP reply");
      return { ok: true, screen: mcpScreen(request.provider, sources.data) };
    } catch {
      return { ok: false, problem: "Couldn't read the MCP servers. Try again." };
    }
  }
  if (request.type === "mcp.screen.control") {
    try {
      await owner.request(
        { type: `mcp.provider.${request.action}`, provider: request.provider, name: request.name },
        options,
      );
      return { ok: true };
    } catch {
      return {
        ok: false,
        problem: `Couldn't ${verbs[request.action]} ${request.name}. Try again, or check it in ${name}.`,
      };
    }
  }
  const check = checkMcpServer(request, request.taken);
  if (!check.ok) return { ok: false, problem: check.problem };
  try {
    await owner.request(
      {
        type: "mcp.provider.add",
        provider: request.provider,
        name: check.name,
        server: check.server,
      },
      options,
    );
    return { ok: true, name: check.name };
  } catch {
    return {
      ok: false,
      problem:
        "Couldn't add the server. Use a unique name and check the command or URL, then try again.",
    };
  }
}
