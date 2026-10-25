import { DeviceChromeResult, type DeviceChrome } from "@ace/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DeviceSession } from "./device-session.ts";

type Client = DeviceSession["client"];
const noSubscribe = () => () => {};

/** The device a look is asked for: devices of one model share it. */
export interface ChromeTarget {
  id: string;
  model?: string | undefined;
}

/**
 * Each channel's answers, per model (or per device, when the daemon names no model): a look
 * doesn't change while the daemon runs, so a list of a dozen iPhone 17 Pros asks once.
 */
const asked = new WeakMap<Client, Map<string, Promise<DeviceChrome | null>>>();

const chromeKey = (target: ChromeTarget) => target.model ?? target.id;

function ask(client: Client, target: ChromeTarget): Promise<DeviceChrome | null> {
  let looks = asked.get(client);
  if (!looks) {
    looks = new Map();
    asked.set(client, looks);
  }
  const key = chromeKey(target);
  let answer = looks.get(key);
  if (!answer) {
    const pending = client
      .request({ op: "chrome", deviceId: target.id })
      .then((data) => DeviceChromeResult.parse(data).chrome);
    // A refusal (an older daemon, a dropped channel) is asked again next time.
    pending.catch(() => looks.delete(key));
    answer = pending;
    looks.set(key, answer);
  }
  return answer;
}

/**
 * The device's real hardware look from its SDK on the daemon's machine, once known: undefined
 * while asking, when `wanted` is false, and when there is none (the caller draws its own frame).
 */
export function useDeviceChrome(
  session: DeviceSession | undefined,
  target: ChromeTarget,
  wanted: boolean,
): DeviceChrome | undefined {
  const client = session?.client;
  const key = chromeKey(target);
  // Asked once the channel is up; a reconnect asks again if the last ask failed.
  const connected = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    () => session?.get().connected ?? false,
  );
  const [known, setKnown] = useState<{
    client: Client;
    key: string;
    chrome: DeviceChrome | null;
  }>();
  const { id, model } = target;
  useEffect(() => {
    if (!wanted || !connected || !client) return;
    let current = true;
    ask(client, { id, model }).then(
      (chrome) => {
        if (current) setKnown({ client, key: chromeKey({ id, model }), chrome });
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [client, id, model, wanted, connected]);
  if (!wanted || !client || known?.client !== client || known.key !== key) return undefined;
  return known.chrome ?? undefined;
}
