import { ThreadId } from "@ace/protocol";
import type { MarketOperation, MarketResult } from "@ace/protocol/marketplace";
import { providerNames } from "@ace/ui-core/providers";
import type { SettingsService } from "@ace/settings";
import type { MachineAccount } from "../account-access/machine-account.ts";
import type { Engine } from "../engine/index.ts";
import type { Store } from "../store.ts";
import { agentMarketRequest } from "./agent-requests.ts";
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
  private account: { account: MachineAccount } | undefined;

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
  bindAccount(account: MachineAccount): void {
    this.account = { account };
  }

  /**
   * `personGrant`: the person's own market grant for a sensitive action (ADR 0190). `by`: whose
   * standing it runs on, the person's (a proven socket, or their answer to an agent's request), or
   * the content-only exemption's, when a Spade skill it installs waits for the person (ADR 0178
   * §12.8).
   */
  asPerson(
    operation: MarketOperation,
    personGrant?: string,
    by: "person" | "without-person" = "person",
  ): Promise<MarketResult> {
    const bound = this.account;
    const grant = bound ? () => bound.account.marketGrant() : undefined;
    // The signed-in person's name and email, for the privacy pass over what they publish.
    const signedIn = bound?.account.account();
    const names = signedIn
      ? [signedIn.name, signedIn.email, signedIn.email.split("@")[0] ?? ""]
      : [];
    return this.deps.marketplace.request(
      operation,
      operation.op === "publish"
        ? { grant, names, personGrant }
        : { names, withoutPerson: by === "without-person" },
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
