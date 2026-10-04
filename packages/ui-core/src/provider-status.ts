import type { ProviderKind } from "@ace/protocol";
import type { AccountView } from "./accounts.ts";
import { providerNames } from "./providers.ts";

/**
 * The native CLIs the daemon's discovery looks for, in its order, with the executable each runs.
 * ACP agents follow them, one per agent the person's accounts name.
 */
export const nativeProviders: readonly { kind: Exclude<ProviderKind, "acp">; binary: string }[] = [
  { kind: "claude", binary: "claude" },
  { kind: "codex", binary: "codex" },
  { kind: "opencode", binary: "opencode" },
  { kind: "cursor", binary: "cursor-agent" },
  { kind: "antigravity", binary: "antigravity" },
];

/**
 * Whether a provider can take a new thread: `ready` (installed, and signed in as far as the
 * daemon reports), `signed_out` (installed, but every ace account of it is signed out) or
 * `not_installed` (discovery didn't find its CLI).
 */
export type ProviderState = "ready" | "signed_out" | "not_installed";

/** One provider as the daemon's discovery and accounts describe it. */
export interface ProviderStatus {
  provider: ProviderKind;
  /** The ACP registry agent behind an `acp` provider. */
  acpAgentId?: string | undefined;
  /** "Codex"; for an ACP agent, its registry name. */
  name: string;
  binary: string;
  /** The CLI version an account reported; undefined when none did. */
  version: string | undefined;
  state: ProviderState;
  /** The person's ace accounts on this provider; empty when the CLI runs on its own login. */
  accounts: readonly AccountView[];
}

/**
 * A provider's state from discovery and its ace accounts. ace never handles credentials
 * (ADR 0002): with no ace account the daemon runs the CLI on the person's own login, so the CLI
 * counts as ready. Only when it has ace accounts and every one is signed out is it signed out.
 */
export function providerState(
  installed: boolean,
  accounts: readonly Pick<AccountView, "signedIn">[],
): ProviderState {
  if (!installed) return "not_installed";
  return accounts.length && !accounts.some((account) => account.signedIn) ? "signed_out" : "ready";
}

/**
 * Every native CLI in discovery order, installed or not, then each ACP agent the accounts name.
 * `installed` is the set of native CLIs discovery found; an ACP agent is installed when it has an
 * account, since the daemon registers ACP accounts only for installed agents.
 */
export function providerStatuses(
  installed: ReadonlySet<ProviderKind>,
  accounts: readonly AccountView[],
): ProviderStatus[] {
  const native = nativeProviders.map(({ kind, binary }): ProviderStatus => {
    const own = accounts.filter((account) => account.provider === kind);
    return {
      provider: kind,
      name: providerNames[kind],
      binary,
      version: own.find((account) => account.version)?.version,
      state: providerState(installed.has(kind), own),
      accounts: own,
    };
  });
  const agents = new Map<string, AccountView[]>();
  for (const account of accounts) {
    if (account.provider !== "acp") continue;
    const bucket = agents.get(account.providerLabel);
    if (bucket) bucket.push(account);
    else agents.set(account.providerLabel, [account]);
  }
  const acp = [...agents].map(([name, own]): ProviderStatus => ({
    provider: "acp",
    acpAgentId: own[0]?.acpAgentId,
    name,
    binary: name,
    version: own.find((account) => account.version)?.version,
    state: providerState(true, own),
    accounts: own,
  }));
  return [...native, ...acp];
}

/** "Codex", "Codex (not signed in)" or "Codex (not installed)", as a provider picker lists it. */
export function providerChoiceLabel(status: Pick<ProviderStatus, "name" | "state">): string {
  if (status.state === "signed_out") return `${status.name} (not signed in)`;
  if (status.state === "not_installed") return `${status.name} (not installed)`;
  return status.name;
}

/**
 * The provider a new thread starts on until the person picks another in the composer. The first
 * of these that is ready wins:
 *
 * 1. `chosen`: the default provider the person picked in Settings. Pass undefined when the
 *    daemon reports the setting at its shipped default (never set), so a schema default is
 *    never mistaken for a choice. It is the person's standing instruction, so it beats habit.
 * 2. `lastUsed`: the provider of the person's last new thread.
 * 3. The first ready provider in discovery order.
 *
 * With none ready, the first installed one (signed out, so the composer says so); undefined when
 * discovery found nothing. A provider that isn't installed is never picked, whatever was chosen.
 */
export function startingProvider(input: {
  chosen: ProviderKind | undefined;
  lastUsed: ProviderKind | undefined;
  providers: readonly Pick<ProviderStatus, "provider" | "state">[];
}): ProviderKind | undefined {
  const { chosen, lastUsed, providers } = input;
  const ready = (kind: ProviderKind | undefined) =>
    kind !== undefined &&
    providers.some((status) => status.provider === kind && status.state === "ready");
  if (ready(chosen)) return chosen;
  if (ready(lastUsed)) return lastUsed;
  return (
    providers.find((status) => status.state === "ready")?.provider ??
    providers.find((status) => status.state === "signed_out")?.provider
  );
}
