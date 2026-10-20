import { RemoteAccessStatus } from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";

/** Where a daemon's relay takes this window's devices channel when its own address won't. */
export type RelayRoute = NonNullable<RemoteAccessStatus["relay"]>;

const key = (daemonUrl: string) => `ace.devices.relay:${daemonUrl}`;
const Route = RemoteAccessStatus.shape.relay.unwrap();

/** The relay route last learned for the daemon at `daemonUrl`. */
export function rememberedRelay(
  storage: KeyValueStorage,
  daemonUrl: string,
): RelayRoute | undefined {
  try {
    const parsed = Route.safeParse(JSON.parse(storage.getItem(key(daemonUrl)) ?? "null"));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asks the daemon for its relay route and remembers the answer (a daemon without a relay forgets
 * the old one). When the daemon can't be asked, the remembered route is the answer: that is when
 * the relay matters.
 */
export async function learnRelay(
  storage: KeyValueStorage,
  daemonUrl: string,
  status: () => Promise<RemoteAccessStatus>,
): Promise<RelayRoute | undefined> {
  let current: RemoteAccessStatus;
  try {
    current = await status();
  } catch {
    return rememberedRelay(storage, daemonUrl);
  }
  if (current.relay) storage.setItem(key(daemonUrl), JSON.stringify(current.relay));
  else storage.removeItem?.(key(daemonUrl));
  return current.relay;
}
