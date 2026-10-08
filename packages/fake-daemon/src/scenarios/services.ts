import { automationList, automationRuns } from "../catalog/automations.ts";
import { pluginCatalog } from "../catalog/plugins.ts";
import { pullRequests } from "../catalog/pull-requests.ts";
import { deckRuns } from "../conductor/decks.ts";
import type { ServicesSeed } from "../services-wire.ts";

/**
 * What the design's daemon has accumulated beside its threads: decks, automations and their
 * recent runs, installed plugins, and pull requests linked to Home threads. Seed it with
 * `daemon.seedServices(workbenchServices(now))` after the threads it links to are played.
 */
export function workbenchServices(now: number, timeZone = "UTC"): ServicesSeed {
  return {
    history: (["claude", "codex", "opencode"] as const).map((provider, index) => ({
      id: `relay-${provider}`,
      instanceId: `${provider}-default`,
      provider,
      nativeId: `fixture-${provider}`,
      cwd: "/Users/dev/relay",
      title:
        ["Trace reconnect ordering", "Keep retry delays bounded", "Audit the background runner"][
          index
        ] ?? "Saved session",
      lastActivity: now - (index + 1) * 3_600_000,
      messageCount: 12,
      countAccuracy: "exact" as const,
      support: { status: "supported" as const },
      continuation: { status: "supported" as const },
    })),
    decks: deckRuns(now),
    automations: automationList(Math.floor(now / 60_000) * 60_000, timeZone),
    runs: automationRuns(now),
    plugins: pluginCatalog(now),
    pullRequests: pullRequests(now),
    // The design's machine runs its automations, so schedules show their next run.
    settings: { "automations.enabled": true },
  };
}
