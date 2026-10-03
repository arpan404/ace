import { webSocketTransport, type Client } from "@ace/client";
import { createBrowserClient, deviceId, localOutbox } from "./client.ts";

/**
 * Connect to a local daemon. The URL comes from VITE_ACE_DAEMON_URL and the token from the
 * `#token=` fragment the daemon opens the app with. The token stays in memory only.
 */
export function bootDaemon(): Client {
  const url = import.meta.env.VITE_ACE_DAEMON_URL ?? "ws://127.0.0.1:7432/v1/socket";
  const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  const device = deviceId();
  return createBrowserClient({
    deviceId: device,
    transport: () => webSocketTransport(() => new WebSocket(url)),
    credential: async () => token,
    storage: localOutbox(`ace.outbox.${url}.${device}`),
  });
}
