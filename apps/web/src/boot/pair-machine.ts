import type { DaemonTarget } from "./connection-settings.ts";
import { createPageClient } from "./page-client.ts";
import { pinnedFingerprint, type PairedMachine } from "@ace/client/machines";
import type { HostIdentity } from "@ace/protocol";

const noop = () => {};

/**
 * What a browser pairing saves. Its direct address keeps the certificate fingerprint the daemon
 * gave for that address over the authenticated connection, so the machine's account entry can
 * use it as a pinned direct path once the two are known to be one machine (ADR 0115).
 */
export function pairedMachineFrom(
  target: DaemonTarget & { pairedDeviceId: string },
  identity: HostIdentity,
  paths: readonly unknown[] | undefined,
  remember: boolean,
): PairedMachine {
  const fingerprint = pinnedFingerprint(target.url, paths);
  return {
    identity,
    deviceId: target.pairedDeviceId,
    token: target.token,
    remember,
    target: target.relayHostId
      ? { kind: "relay", url: target.url, ticketReference: target.relayHostId }
      : { kind: "direct", url: target.url, ...(fingerprint ? { fingerprint } : {}) },
  };
}

/** A temporary authenticated connection reads identity before the pool pins and stores it. */
export async function readPairedMachine(
  target: DaemonTarget,
  remember: boolean,
  signal: AbortSignal,
): Promise<PairedMachine> {
  const pairedDeviceId = target.pairedDeviceId;
  if (!pairedDeviceId) throw new Error("Create a fresh pairing link on the other computer.");
  signal.throwIfAborted();
  const client = createPageClient(target, {
    deviceId: pairedDeviceId,
    outboxKey: `pair:${target.url}`,
  });
  let stop = noop;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = noop;
  try {
    const deadline = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Pairing cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () =>
          reject(new Error("This computer didn't respond. Check the connection and try again.")),
        15000,
      );
    });
    const ready = new Promise<void>((resolve, reject) => {
      const changed = () => {
        if (client.state === "ready") resolve();
        if (client.state === "fatal")
          reject(
            new Error("Couldn't verify this computer. Create a fresh pairing link and try again."),
          );
      };
      stop = client.connectionState().subscribe(changed);
      changed();
    });
    const { identity, paths } = await Promise.race([
      (async () => {
        await Promise.all([client.start(), ready]);
        signal.throwIfAborted();
        return client.request({ type: "host.identity" });
      })(),
      deadline,
    ]);
    signal.throwIfAborted();
    return pairedMachineFrom({ ...target, pairedDeviceId }, identity, paths, remember);
  } finally {
    signal.removeEventListener("abort", abort);
    stop();
    clearTimeout(timer);
    await client.close();
  }
}
