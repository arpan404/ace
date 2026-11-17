import type { StartupNotice } from "@ace/protocol";
import type { ServiceStatus } from "./startup.ts";

/** Services whose code name is not how a person says it. */
const named: Partial<Record<string, string>> = {
  agentControl: "Agent control",
  agentRegistry: "Agents",
  providerStatuses: "Provider status",
  providerLogin: "Provider sign-in",
  providerInstalls: "Provider installs",
  accountManagement: "Accounts",
  userBrowser: "Browser",
  externalMcp: "Connected apps",
  mcp: "Tools",
  pi: "Pi",
  previewClient: "Previews",
  backgroundPorts: "Background ports",
  sidebarPlacement: "Sidebar",
  activityReads: "Activity",
  workspaceActions: "Workspace actions",
};

/** The name a person knows a service by: "commands" is "Commands", "relay" is "Relay". */
export function serviceTitle(name: string): string {
  const known = named[name];
  if (known) return known;
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What the daemon runs without right now, from its service statuses; undefined while everything
 * runs. A service that is merely starting counts as neither.
 */
export function startupNotice(statuses: readonly ServiceStatus[]): StartupNotice | undefined {
  const without = statuses.filter((s) => s.skipped).map((s) => serviceTitle(s.name));
  const failing = statuses
    .filter((s) => s.state === "degraded" && !s.skipped)
    .map((s) => ({ name: serviceTitle(s.name), retrying: s.retrying !== false }));
  return without.length || failing.length ? { without, failing } : undefined;
}
