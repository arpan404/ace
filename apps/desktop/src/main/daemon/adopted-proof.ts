import { appSocketSignature, type AppKeyPair } from "@ace/service/app-signature";
import type { LocalDaemon } from "./probe.ts";

/** After a daemon asked for a fresh sign-in, how long before the app asks it again. */
const refusalPauseMs = 60_000;

export interface AdoptedProofPorts {
  /** The app's key pair for that daemon home; undefined without a keychain to keep it in. */
  pair(hostId: string): Promise<AppKeyPair | undefined>;
  /**
   * Register the public key there (`POST /v1/app-key`): that daemon's run id once it is
   * registered, undefined while registering needs a fresh ace sign-in.
   */
  register(daemon: LocalDaemon, publicKey: string): Promise<string | undefined>;
  now(): number;
}

/**
 * The page's proof for a daemon this app didn't start (ADR 0178 §12.8): a login service's, a
 * terminal's. The app registers its key there once, which takes a fresh ace sign-in, and then
 * signs that daemon's port and run id. Until then the page is a host-token socket, as before.
 */
export function adoptedProofs(ports: AdoptedProofPorts) {
  const refused = new Map<string, number>();
  return {
    async withProof(daemon: LocalDaemon): Promise<LocalDaemon> {
      const hostId = daemon.hostId;
      if (daemon.appProof !== undefined || hostId === undefined) return daemon;
      const at = refused.get(hostId);
      if (at !== undefined && ports.now() - at < refusalPauseMs) return daemon;
      const pair = await ports.pair(hostId).catch(() => undefined);
      if (!pair) return daemon;
      const run = await ports.register(daemon, pair.x).catch(() => undefined);
      if (run === undefined) {
        refused.set(hostId, ports.now());
        return daemon;
      }
      refused.delete(hostId);
      const port = Number(new URL(daemon.url).port || 80);
      return { ...daemon, appProof: appSocketSignature(pair, port, run) };
    },
    /** The person just signed in through the app: ask again at the next hand-off. */
    retry(): void {
      refused.clear();
    },
  };
}
