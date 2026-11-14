import type { ServiceDefinition } from "./startup.ts";

/** A service's place in startup, without its start function: pure data, for tests too. */
export type ServiceOrder = Omit<ServiceDefinition, "start">;
export type ServiceName = (typeof serviceOrder)[number]["name"];
/** Dependencies are explicit; optional integration failures do not disable the engine. */
export const serviceOrder = [
  { name: "screen", phase: "core", requires: [], after: [] },
  { name: "settings", phase: "core", requires: [], after: [] },
  {
    name: "sourceControl",
    phase: "core",
    requires: ["settings"],
    after: [],
  },
  { name: "accounts", phase: "core", requires: [], after: [] },
  {
    name: "providerStatuses",
    phase: "core",
    requires: [],
    after: ["accounts", "settings"],
  },
  { name: "commands", phase: "core", requires: ["accounts"], after: [] },
  { name: "files", phase: "core", requires: [], after: [] },
  {
    name: "devices",
    phase: "core",
    requires: [],
    after: ["screen", "files", "settings"],
  },
  { name: "relay", phase: "core", requires: ["files"], after: [] },
  { name: "plugins", phase: "core", requires: [], after: [] },
  { name: "activityReads", phase: "core", requires: [], after: [] },
  {
    name: "sidebarPlacement",
    phase: "core",
    requires: [],
    after: ["settings", "activityReads"],
  },
  { name: "icons", phase: "core", requires: [], after: [] },
  { name: "userBrowser", phase: "core", requires: [], after: [] },
  {
    name: "browser",
    phase: "core",
    requires: [],
    after: ["settings", "userBrowser"],
  },
  { name: "browsing", phase: "core", requires: [], after: ["browser"] },
  {
    name: "workspaceActions",
    phase: "core",
    requires: [],
    after: ["files", "sourceControl"],
  },
  {
    name: "verify",
    phase: "core",
    requires: ["workspaceActions"],
    after: ["workspaceActions"],
  },
  {
    name: "projects",
    phase: "core",
    requires: ["settings"],
    after: ["workspaceActions"],
  },
  {
    name: "models",
    phase: "core",
    requires: ["accounts"],
    after: ["settings", "accounts"],
  },
  {
    name: "utility",
    phase: "core",
    requires: [],
    after: ["settings", "accounts", "providerStatuses", "models"],
  },
  {
    name: "mcp",
    phase: "core",
    requires: [],
    after: ["screen", "browser", "devices"],
  },
  {
    name: "transitions",
    phase: "core",
    requires: [],
    after: ["accounts"],
  },
  { name: "pi", phase: "core", requires: [], after: ["mcp"] },
  { name: "agentRegistry", phase: "core", requires: [], after: [] },
  {
    // Without the engine every command fails with engine_unavailable: refuse to start instead.
    name: "engine",
    phase: "core",
    essential: true,
    requires: ["accounts"],
    after: [
      "accounts",
      "plugins",
      "settings",
      "models",
      "mcp",
      "pi",
      "agentRegistry",
      "transitions",
      "workspaceActions",
    ],
  },
  {
    name: "cursorAuth",
    phase: "listener",
    requires: ["engine", "accounts"],
    after: [],
  },
  {
    name: "accountManagement",
    phase: "listener",
    requires: ["accounts"],
    after: ["engine", "models", "cursorAuth"],
  },
  {
    name: "providerLogin",
    phase: "listener",
    requires: ["accounts"],
    after: ["models", "providerStatuses", "accountManagement", "cursorAuth"],
  },
  {
    name: "providerInstalls",
    phase: "listener",
    requires: [],
    after: ["models", "providerStatuses"],
  },
  { name: "context", phase: "listener", requires: [], after: [] },
  { name: "review", phase: "listener", requires: [], after: [] },
  { name: "history", phase: "listener", requires: [], after: ["engine"] },
  { name: "usage", phase: "listener", requires: [], after: [] },
  { name: "notifications", phase: "listener", requires: [], after: [] },
  {
    name: "agentControl",
    phase: "listener",
    requires: ["engine"],
    after: ["accounts", "context", "notifications", "settings"],
  },
  {
    name: "machines",
    phase: "listener",
    requires: ["engine"],
    after: ["agentControl", "settings", "browser"],
  },
  {
    name: "transfers",
    phase: "listener",
    requires: ["engine"],
    after: ["machines", "projects", "workspaceActions", "settings", "agentControl"],
  },
  {
    name: "externalMcp",
    phase: "listener",
    requires: ["agentControl"],
    // Outside clients start work: machines' and transfers' hooks must be on the engine first.
    after: ["agentControl", "browser", "screen", "models", "settings", "machines", "transfers"],
  },
  {
    // Spade's grant acts as its host thread on the MCP endpoint, stored beside the outside
    // clients' grants but listed and revoked only through spade.*.
    name: "spade",
    phase: "listener",
    requires: ["settings"],
    after: [
      "settings",
      "engine",
      "mcp",
      "agentControl",
      "projects",
      "externalMcp",
      "machines",
      "transfers",
    ],
  },
  { name: "previewClient", phase: "listener", requires: [], after: [] },
  {
    name: "backgroundPorts",
    phase: "listener",
    requires: ["engine"],
    after: [],
  },
  {
    name: "threadOrganization",
    phase: "listener",
    requires: ["settings"],
    // It moves threads on its own schedule: a thread under a transfer hold stays put.
    after: ["engine", "settings", "workspaceActions", "transfers"],
  },
  {
    name: "automations",
    phase: "listener",
    requires: ["engine", "settings"],
    // Missed runs start at once: machines' and transfers' hooks must be on the engine first.
    after: ["context", "agentControl", "workspaceActions", "machines", "transfers"],
  },
  {
    name: "storage",
    phase: "listener",
    requires: ["context", "workspaceActions"],
    after: [
      "engine",
      "agentControl",
      "threadOrganization",
      "browser",
      "settings",
      "automations",
      "transfers",
    ],
  },
] as const satisfies readonly ServiceOrder[];
