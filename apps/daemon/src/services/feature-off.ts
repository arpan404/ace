import type { ServiceStatus } from "./startup.ts";

/** How a person knows each service another one depends on. */
const known: Partial<Record<string, string>> = {
  agentControl: "agent control",
  machines: "machine links",
  engine: "the agent engine",
  settings: "settings",
};

/**
 * Why a feature is missing on this machine, from its service's startup status. A client is
 * welcomed only once every listener-phase service has started or failed, so a missing feature
 * is off until ace restarts: never "not ready yet", which suggests waiting will help.
 * `/v1/status` names the same service and reason.
 */
export function featureOff(
  status: (() => readonly ServiceStatus[]) | undefined,
  service: string,
  feature: string,
): string {
  const entry = status?.().find((candidate) => candidate.name === service);
  const dependency = /Dependency (\w+) is unavailable/.exec(entry?.error ?? "")?.[1];
  const cause = dependency
    ? `${known[dependency] ?? dependency} couldn't start`
    : entry?.state === "degraded"
      ? "they couldn't start"
      : "they aren't set up";
  return `${feature} are off on this machine: ${cause}. Restart ace to try again.`;
}
