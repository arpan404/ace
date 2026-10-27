import type { ClientCore } from "@ace/client";
import { z } from "zod";
import { host } from "./host.ts";
import { AccountsScreenRequest, answerAccountsScreen } from "./settings-accounts.ts";
import { answerMcpScreen, McpScreenRequest } from "./settings-mcp.ts";
import { answerRegistryScreen, RegistryScreenRequest } from "./settings-registry.ts";

/*
 * The phone's Settings management screens that the bridge answers itself: the ACP registry and
 * manual agents, a provider's accounts and badges, and a provider's own MCP servers. Each
 * answer is `{ ok, … }` with any failure already in words a person can act on.
 */

export const SettingsManageRequest = z.union([
  RegistryScreenRequest,
  AccountsScreenRequest,
  McpScreenRequest,
]);
export type SettingsManageRequest = z.infer<typeof SettingsManageRequest>;

export async function answerSettingsManage(
  owner: Pick<ClientCore, "request" | "registry">,
  request: SettingsManageRequest,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    if (request.type.startsWith("acp."))
      return await answerRegistryScreen(
        owner,
        RegistryScreenRequest.parse(request),
        signal,
        host.now(),
      );
    if (request.type.startsWith("accounts."))
      return await answerAccountsScreen(
        owner,
        AccountsScreenRequest.parse(request),
        signal,
        host.now(),
      );
    return await answerMcpScreen(owner, McpScreenRequest.parse(request), signal);
  } catch {
    return { ok: false, problem: "Couldn't reach the machine. Check the connection and retry." };
  }
}
