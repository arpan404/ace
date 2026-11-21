import type { MarketKeySet } from "@ace/protocol/marketplace";
import type { GitRuntime } from "@ace/plugins";
import type { MarketFetch } from "./http.ts";
import type { PluginPort, SpadePort, SuitPort } from "./install.ts";
import type { PickPorts } from "./pick.ts";
import type { Membership } from "./org-registry.ts";
import type { MarketGrantPort } from "./publish.ts";

/* What the marketplace service (`service.ts`) is opened with, and what one request adds. */

/** The plugin manager as the marketplace uses it (`plugin-port.ts`). */
export type MarketPluginPort = PluginPort;

export interface MarketplaceOptions {
  root: string;
  now: () => number;
  id: () => string;
  fetch: MarketFetch;
  /** https://market.acehq.dev; another origin only through the development setting. */
  origin: string;
  keys: MarketKeySet;
  git: GitRuntime;
  suits: () => SuitPort | undefined;
  plugins: () => MarketPluginPort | undefined;
  spade: SpadePort;
  /** What the publish flow's picker reads: Spade's bots and skills, ace's skills, plugins. */
  pick?: PickPorts | undefined;
  /** Runs `run` after `ms`; returns its cancel. */
  schedule: (run: () => void, ms: number) => () => void;
  /**
   * Settings › Beta's switch (`beta.marketplace`), read when each request and each queued job
   * starts, before every network fetch and before every install step. On when absent.
   */
  enabled?: () => Promise<boolean>;
  /** Tests add catalogs by local path; people add https addresses only. */
  allowLocalGit?: boolean;
}

/** What one request may use beyond the service's own ports. */
export interface MarketRequestPorts {
  /** Mints a market grant for a `publish` action; absent or undefined answers `signed_out`. */
  grant?: MarketGrantPort | undefined;
  /** The signed-in person's own name and email, which the privacy pass flags. */
  names?: readonly string[] | undefined;
  /** A person's market grant the client sent for this request's one call (ADR 0190). */
  personGrant?: string | undefined;
  /**
   * The request runs on the content-only exemption, not on the person's standing (ADR 0178
   * §12.8): a Spade skill it installs waits for the person to turn it on for their bots.
   */
  withoutPerson?: boolean | undefined;
  /**
   * A market grant acting in an organization that the client got with the person's own session
   * (ADR 0206 §5.3): the request reads that organization's registry with it, and installs from it
   * only with it.
   */
  orgGrant?: string | undefined;
  /** What checking `orgGrant` needs: the backend's keys and who this machine answers to. */
  membership?: Membership | undefined;
}
