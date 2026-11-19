import { useDaemonSetting } from "./daemon-setting.ts";

/** The features Settings › Beta turns on and off, each a global daemon setting (`beta.*`). */
export type BetaFeature = "spade" | "marketplace";

const keys = { spade: "beta.spade", marketplace: "beta.marketplace" } as const;

/**
 * Whether `feature` is turned on in Settings › Beta on this window's machine: true or false, and
 * undefined until the daemon has answered. Live: the setting's watch follows every change. Every
 * way into a beta feature asks this, so turning it off hides them all at once.
 */
export function useBetaEnabled(feature: BetaFeature): boolean | undefined {
  const [value] = useDaemonSetting(keys[feature]);
  return value;
}
