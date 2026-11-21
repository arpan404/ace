import type { SignerReport } from "@ace/marketplace/signer";
import type { RegistryKeychain } from "./keychain.ts";

/*
 * The org host's signer loop (ADR 0206 §5.2): on the organization's host whose keychain holds its
 * registry key, what waits in the registry is signed every few minutes, so a version is offered
 * while people sleep. It does nothing on any other machine. One run at a time; a failed run is
 * logged and the next one tries again.
 */

export const registrySignIntervalMs = 10 * 60_000;

export interface RegistrySignerLoopDeps {
  /** The organization whose host this is, if any. */
  org(): string | undefined;
  keychain: RegistryKeychain;
  sign(org: string): Promise<SignerReport>;
  /** Runs `callback` after `ms`; the stop it answers cancels it. */
  delay(callback: () => void, ms: number): () => void;
  intervalMs?: number;
  log?(message: string): void;
}

export function registrySignerLoop(deps: RegistrySignerLoopDeps) {
  let cancel: (() => void) | undefined;
  let running: Promise<SignerReport | undefined> | undefined;
  let stopped = false;
  const round = async (): Promise<SignerReport | undefined> => {
    const org = deps.org();
    if (org === undefined) return undefined;
    const keys = await deps.keychain.read(org).catch(() => undefined);
    if (!keys) return undefined;
    return deps.sign(org);
  };
  const runOnce = () => {
    running ??= round()
      .catch((error: unknown) => {
        deps.log?.(`registry signer: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const schedule = () => {
    if (stopped) return;
    cancel = deps.delay(() => {
      void runOnce().finally(schedule);
    }, deps.intervalMs ?? registrySignIntervalMs);
  };
  return {
    start(): void {
      schedule();
    },
    /** One round now, as the timer would run it: what it signed, or nothing to do. */
    runOnce,
    stop(): void {
      stopped = true;
      cancel?.();
    },
  };
}
