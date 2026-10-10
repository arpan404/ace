import type { DaemonTarget } from "./connection-settings.ts";
import { createPageClient } from "./page-client.ts";
import type { PairedMachine } from "@ace/client/machines";

const noop = () => {};

/** A temporary authenticated connection reads identity before the pool pins and stores it. */
export async function readPairedMachine(
  target: DaemonTarget,
  remember: boolean,
  signal: AbortSignal,
): Promise<PairedMachine> {
  if (!target.pairedDeviceId) throw new Error("Create a fresh pairing link on the other computer.");
  signal.throwIfAborted();
  const client = createPageClient(target, {
    deviceId: target.pairedDeviceId,
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
    const { identity } = await Promise.race([
      (async () => {
        await Promise.all([client.start(), ready]);
        signal.throwIfAborted();
        return client.request({ type: "host.identity" });
      })(),
      deadline,
    ]);
    signal.throwIfAborted();
    return {
      identity,
      deviceId: target.pairedDeviceId,
      token: target.token,
      remember,
      target: { kind: "direct", url: target.url },
    };
  } finally {
    signal.removeEventListener("abort", abort);
    stop();
    clearTimeout(timer);
    await client.close();
  }
}
