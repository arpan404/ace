import { ThreadId } from "@ace/protocol";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import { providerNames } from "@ace/ui-core/providers";
import type { SettingsService } from "@ace/settings";
import type { MachineAccount } from "../account-access/machine-account.ts";
import type { Engine } from "../engine/index.ts";
import type { Store } from "../store.ts";
import { grantSignedInAt, grantSignInAge } from "@ace/account-grant";
import { agentMarketRequest } from "./agent-requests.ts";
import { signedInRecently } from "./fresh-sign-in.ts";
import { MarketPersonRequests } from "./person-requests.ts";
import type { MarketplaceService } from "./service.ts";

/** The setting that turns every agent publish into the person's request (ADR 0178 decision 1). */
export const askBeforeAgentPublishKey = "market.askBeforeAgentPublish";

/** The one settings read the market's agent rules make. */
export interface SettingReader {
  get(key: typeof askBeforeAgentPublishKey): Promise<{ readonly value: unknown }>;
}

/**
 * "Ask me before agents publish", failing closed (ADR 0178 decision 1): off only when the
 * person's setting reads off. Settings not loaded yet, a read that fails, or a value that isn't
 * a boolean count as on, so a broken settings file never lets an agent publish unasked.
 */
export async function askBeforeAgentPublish(settings: SettingReader | undefined): Promise<boolean> {
  if (!settings) return true;
  try {
    const read = await settings.get(askBeforeAgentPublishKey);
    return read.value !== false;
  } catch {
    return true;
  }
}

export interface MarketAgentDeps {
  readonly marketplace: MarketplaceService;
  readonly store: Store;
  engine(): Engine | undefined;
  settings(): SettingsService | undefined;
  id(): string;
}

/**
 * The marketplace as a caller reaches it: as the person (a device, the CLI in their terminal),
 * or as an agent in a thread (ace's MCP tools, the CLI in an agent's shell), whose person-only
 * actions become requests in its thread. A `publish` mints a market grant through this
 * machine's ace account for that request alone (ADR 0174 §2).
 */
export class MarketAgent {
  readonly requests: MarketPersonRequests;
  private readonly deps: MarketAgentDeps;
  private account: { account: MachineAccount; hostId: string } | undefined;

  constructor(deps: MarketAgentDeps) {
    this.deps = deps;
    this.requests = new MarketPersonRequests({
      store: deps.store,
      engine: deps.engine,
      id: deps.id,
      run: (operation) => this.asPerson(operation),
    });
  }

  /** The machine's ace account, once the daemon has loaded it. */
  bindAccount(account: MachineAccount, hostId: string): void {
    this.account = { account, hostId };
  }

  /**
   * Whether this machine's ace account signed in within the last ten minutes (ADR 0174 §2),
   * read from the `authAt` of a market grant taken for the check. False when signed out or
   * the account service can't be reached.
   */
  async freshSignIn(): Promise<boolean> {
    return (await this.freshSignInAt()) !== undefined;
  }

  /** When this machine's ace account signed in, if that was in the last ten minutes. */
  async freshSignInAt(): Promise<number | undefined> {
    const bound = this.account;
    if (!bound) return undefined;
    try {
      const grant = await bound.account.marketGrant(bound.hostId);
      return grant !== undefined && signedInRecently(grantSignInAge(grant))
        ? grantSignedInAt(grant)
        : undefined;
    } catch {
      return undefined;
    }
  }

  asPerson(operation: MarketOperation): Promise<MarketResult> {
    const bound = this.account;
    const grant = bound ? () => bound.account.marketGrant(bound.hostId) : undefined;
    // The signed-in person's name and email, for the privacy pass over what they publish.
    const signedIn = bound?.account.account();
    const names = signedIn
      ? [signedIn.name, signedIn.email, signedIn.email.split("@")[0] ?? ""]
      : [];
    return this.deps.marketplace.request(
      operation,
      operation.op === "publish" ? { grant, names } : { names },
    );
  }

  forAgent(threadId: string, operation: MarketOperation): Promise<MarketResult> {
    return agentMarketRequest(
      {
        run: (next) => this.asPerson(next),
        requests: () => this.requests,
        askBeforePublish: () => askBeforeAgentPublish(this.deps.settings()),
        agentName: (thread) => {
          const id = ThreadId.safeParse(thread);
          const provider = id.success ? this.deps.store.getThread(id.data)?.provider : undefined;
          return provider ? providerNames[provider] : "An agent";
        },
      },
      threadId,
      operation,
    );
  }
}
