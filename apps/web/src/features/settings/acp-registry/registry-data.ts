import type { ClientApi } from "@ace/client";
import type {
  RegistryAgent,
  RegistryInstallation,
  RegistryInstallPlan,
  RegistryInstallProgress,
  RegistryResult,
} from "@ace/protocol";
import { registryFailure } from "@ace/ui-core/acp-registry";

/*
 * The daemon's ACP registry service (`Client.registry`): the cached index, a background refresh,
 * install plans, the separate install intent that executes one, its progress and cancel. Every
 * failure leaves here as a RegistryError in fixed words, never the daemon's raw reason.
 */

/** The cached registry as the browser shows it, with what's installed and installing. */
export interface RegistryView {
  agents: RegistryAgent[];
  installations: RegistryInstallation[];
  fetchedAt: number | undefined;
  /** Older than the daemon's freshness window, or never downloaded. */
  stale: boolean;
  /** The last refresh couldn't reach the registry; this is the saved list. */
  refreshFailed: boolean;
  activeInstall: RegistryInstallProgress | undefined;
}

/** A registry failure; `message` is the friendly copy. */
export class RegistryError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(registryFailure(reason));
    this.name = "RegistryError";
    this.reason = reason;
  }
}

type Result = RegistryResult["result"];
type Listing = Extract<Result, { agents: unknown }>;

function refused(result: Result): RegistryError | undefined {
  return result.ok ? undefined : new RegistryError(result.reason);
}

function listing(reply: RegistryResult): Listing {
  const error = refused(reply.result);
  if (error) throw error;
  if (!("agents" in reply.result)) throw new RegistryError("Unexpected registry reply");
  return reply.result;
}

/** The whole cached index (50 entries a page, at most the daemon's 2,048), no network. */
export async function readRegistry(client: ClientApi, signal?: AbortSignal): Promise<RegistryView> {
  const options = signal ? { signal } : {};
  const agents: RegistryAgent[] = [];
  let page = listing(
    await client.registry({ type: "registry.list", offset: 0, limit: 50 }, options),
  );
  agents.push(...page.agents);
  while (page.nextOffset !== undefined && page.nextOffset < 2048) {
    page = listing(
      await client.registry({ type: "registry.list", offset: page.nextOffset, limit: 50 }, options),
    );
    agents.push(...page.agents);
  }
  return {
    agents,
    installations: page.installations,
    fetchedAt: page.fetchedAt,
    stale: page.stale,
    refreshFailed: page.error === "refresh_failed",
    activeInstall: page.activeInstall,
  };
}

/** Download the index again (one bounded flight on the daemon); the cache stays on failure. */
export async function refreshRegistry(client: ClientApi): Promise<void> {
  const reply = listing(await client.registry({ type: "registry.refresh" }));
  if (reply.error === "refresh_failed") throw new RegistryError("Refresh failed");
}

/**
 * The plan to install `agent` here: the first runtime it offers that this computer can use
 * (a verified binary, else npm, else uv). When none can, the first refusal explains why.
 */
export async function planInstall(
  client: ClientApi,
  agent: RegistryAgent,
): Promise<RegistryInstallPlan> {
  let first: RegistryError | undefined;
  for (const runtime of agent.runtimes ?? []) {
    const reply = await client.registry({
      type: "registry.install-plan",
      acpAgentId: agent.acpAgentId,
      runtime,
    });
    if (reply.result.ok && "plan" in reply.result) return reply.result.plan;
    first ??= refused(reply.result) ?? new RegistryError("Unexpected registry reply");
  }
  throw first ?? new RegistryError("Package distribution unavailable");
}

/** The daemon's install deadline is five minutes; wait a little longer for its answer. */
const installWaitMs = 6 * 60_000;

/** Execute an approved plan: the intent carries its digest and an idempotency id. */
export async function installAgent(
  client: ClientApi,
  plan: RegistryInstallPlan,
  intentId: string,
): Promise<RegistryInstallation> {
  const reply = await client.registry(
    { type: "registry.install-intent", digest: plan.digest, intentId },
    { timeoutMs: installWaitMs },
  );
  const error = refused(reply.result);
  if (error) throw error;
  if (!("installation" in reply.result)) throw new RegistryError("Unexpected registry reply");
  return reply.result.installation;
}

/** Stop an install; false once it has started saving (it then completes). */
export async function cancelInstall(client: ClientApi, intentId: string): Promise<boolean> {
  const reply = await client.registry({ type: "registry.install-cancel", intentId });
  return reply.result.ok && "cancelled" in reply.result && reply.result.cancelled;
}

/** The running install's phase and bytes, from one small page of the list. */
export async function readInstallProgress(
  client: ClientApi,
  signal?: AbortSignal,
): Promise<RegistryInstallProgress | null> {
  const page = listing(
    await client.registry({ type: "registry.list", offset: 0, limit: 1 }, signal ? { signal } : {}),
  );
  return page.activeInstall ?? null;
}
