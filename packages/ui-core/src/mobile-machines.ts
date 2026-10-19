import type { ConnectionState } from "@ace/client";
import type { ProviderStatus } from "@ace/protocol";
import type { AccountSummary } from "@ace/protocol/accounts";
import type { z } from "zod";
import { accountView } from "./accounts.ts";
import { readinessView, type ReadinessTone } from "./provider-readiness.ts";
import { providerDisplayName } from "./providers.ts";
import { resetCountdown, usageLimits } from "./usage-limits.ts";
import type { StatusDisplay, StatusToken } from "./mobile-status.ts";

/*
 * The native Machines sheet (issue #560): how each paired computer's connection reads, and the
 * coding-agent CLIs on it with their sign-in and usage. Words come from the shared readiness and
 * usage rules the desktop settings use; native code maps tokens to colours and draws.
 */

/**
 * A paired computer's connection in one word. `problem` is the bridge's reason code when the
 * connection isn't ready (pin, revoked, identity, offline, unreachable, storage, version).
 */
export function machineConnection(state: ConnectionState, problem?: string): StatusDisplay {
  if (state === "ready") return { label: "Connected", token: "done" };
  if (problem === "pin" || problem === "revoked" || problem === "identity")
    return { label: "Pair again", token: "failed" };
  if (problem === "version" || problem === "storage")
    return { label: "Needs attention", token: "failed" };
  if (state === "offline") return { label: "Offline", token: "neutral" };
  if (state === "reconnecting") return { label: "Can't reach", token: "neutral" };
  return { label: "Connecting…", token: "neutral" };
}

export interface MachineUsageLine {
  /** "Session (5h)", or "Work · Weekly" when the provider has more than one account. */
  label: string;
  /** "62% left". */
  left: string;
  /** "Resets in 4h 59m"; "Reset since this reading" once it has passed; null when unknown. */
  resets: string | null;
}

export interface MachineProvider {
  provider: string;
  name: string;
  /** "Ready", "Sign in needed", "Update needed"… */
  status: StatusDisplay;
  /** "Signed in as arpan@…", or what the person should do. */
  summary: string;
  version: string | undefined;
  usage: MachineUsageLine[];
}

export interface MachineProviders {
  /** CLIs found on the machine, in the daemon's order. */
  providers: MachineProvider[];
  /** Names of CLIs that aren't installed or are turned off: one quiet line. */
  absent: string[];
}

const toneTokens: Record<ReadinessTone, StatusToken> = {
  ready: "done",
  action: "needsYou",
  problem: "failed",
  idle: "neutral",
};

/**
 * The CLIs a machine reports (`providers.request` readiness) and their usage windows
 * (`accounts.list`). Usage is optional: a machine that withholds accounts still lists its CLIs.
 */
export function machineProviders(
  statuses: readonly ProviderStatus[],
  accounts: readonly z.infer<typeof AccountSummary>[],
  now: number,
): MachineProviders {
  const limits = usageLimits(
    accounts.map((summary) => ({ account: accountView(summary), environment: "" })),
    now,
  );
  const providers: MachineProvider[] = [];
  const absent: string[] = [];
  for (const status of statuses) {
    const name = providerDisplayName(status.provider);
    let view = readinessView(status);
    // Phones load no model catalog, so a CLI that doesn't report its sign-in would read
    // "Checking…" forever. Say what is known instead.
    if (view.state === "checking" && view.unreported && status.installed === true)
      view = {
        ...view,
        label: "Installed",
        summary: `${name} doesn't report who is signed in.`,
        detail: undefined,
      };
    if (view.state === "not_installed" || view.state === "off") {
      absent.push(name);
      continue;
    }
    const group = limits.providers.find((entry) => entry.provider === status.provider);
    const several = (group?.accounts.length ?? 0) > 1;
    const usage: MachineUsageLine[] = [];
    for (const account of group?.accounts ?? [])
      for (const window of account.windows) {
        const countdown = resetCountdown(window.resetsAt, now);
        usage.push({
          label: several ? `${account.account.label} · ${window.label}` : window.label,
          left: `${window.leftPercent}% left`,
          resets: window.stale
            ? "Reset since this reading"
            : countdown === null
              ? null
              : `Resets in ${countdown}`,
        });
      }
    providers.push({
      provider: status.provider,
      name,
      status: { label: view.label, token: toneTokens[view.tone] },
      summary: view.detail ?? view.summary,
      version: status.version ?? undefined,
      usage,
    });
  }
  return { providers, absent };
}
