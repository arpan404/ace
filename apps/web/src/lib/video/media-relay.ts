import { browserDeviceSocket, ephemeralRelayKeys } from "@ace/client/devices";
import { relayMediaStreams, type OpenMediaRelay } from "@ace/client/media";
import type { ChannelEndpoint } from "@/boot/main-machine.ts";

const schedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * Media connections through the relay for a daemon this browser reaches only through it (paired
 * through a relay, pinned to its host key, as the devices channel is). Undefined for one reached
 * directly, whose grants name a `url`, and for the fake daemon.
 */
export function mediaRelayFor(endpoint: ChannelEndpoint | undefined): OpenMediaRelay | undefined {
  if (!endpoint || endpoint.kind === "fake") return undefined;
  const { target, deviceId } = endpoint;
  if (!target.relayHostId) return undefined;
  const token = target.token;
  return relayMediaStreams({
    relayUrl: target.url,
    pinnedFingerprint: target.relayHostId,
    deviceId,
    // Inside the encrypted channel the paired token itself, as for the devices channel.
    credential: async () => token,
    socket: browserDeviceSocket,
    keys: ephemeralRelayKeys,
    schedule,
  });
}
