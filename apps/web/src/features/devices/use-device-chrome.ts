import { DeviceChromeResult, type DeviceChrome } from "@ace/protocol";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DeviceSession } from "./device-session.ts";

type Client = DeviceSession["client"];

/** Each channel's answers, per device: a look doesn't change while the daemon runs. */
const asked = new WeakMap<Client, Map<string, Promise<DeviceChrome | null>>>();

function ask(client: Client, deviceId: string): Promise<DeviceChrome | null> {
  let devices = asked.get(client);
  if (!devices) {
    devices = new Map();
    asked.set(client, devices);
  }
  let answer = devices.get(deviceId);
  if (!answer) {
    const pending = client
      .request({ op: "chrome", deviceId })
      .then((data) => DeviceChromeResult.parse(data).chrome);
    // A refusal (an older daemon, a dropped channel) is asked again next time.
    pending.catch(() => devices.delete(deviceId));
    answer = pending;
    devices.set(deviceId, answer);
  }
  return answer;
}

/**
 * The device's real hardware look from its SDK on the daemon's machine, once known: undefined
 * while asking, when `wanted` is false, and when there is none (the caller draws its own frame).
 */
export function useDeviceChrome(
  session: DeviceSession,
  deviceId: string,
  wanted: boolean,
): DeviceChrome | undefined {
  const { client } = session;
  // Asked once the channel is up; a reconnect asks again if the last ask failed.
  const connected = useSyncExternalStore(session.subscribe, () => session.get().connected);
  const [known, setKnown] = useState<{ client: Client; id: string; chrome: DeviceChrome | null }>();
  useEffect(() => {
    if (!wanted || !connected) return;
    let current = true;
    ask(client, deviceId).then(
      (chrome) => {
        if (current) setKnown({ client, id: deviceId, chrome });
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [client, deviceId, wanted, connected]);
  if (!wanted || known?.client !== client || known.id !== deviceId) return undefined;
  return known.chrome ?? undefined;
}
