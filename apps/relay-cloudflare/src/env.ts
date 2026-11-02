import type { RelayObject } from "./relay-object.ts";

export interface Env {
  RELAY: DurableObjectNamespace<RelayObject>;
  /** Upgrade rate limit per client address. Absent where no limit is configured. */
  UPGRADES?: RateLimit;
}
