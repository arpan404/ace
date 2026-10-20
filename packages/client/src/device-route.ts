import { keyPair } from "@ace/secure-channel";
import type { DeviceTransport } from "@ace/devices/client";
import type { PortableRelayOptions } from "./portable-relay.ts";

/**
 * Fresh keys for one relay channel. The client's static key isn't pinned by the daemon (the
 * paired credential inside the channel is what authenticates it), so nothing is stored.
 */
export const ephemeralRelayKeys: PortableRelayOptions["keys"] = () => ({
  staticKey: keyPair(),
  ephemeralKey: keyPair(),
});

/**
 * A devices channel with a second way in: `primary` (the daemon's own address) first, and when
 * it closes before the daemon welcomed it, the route `fallback` resolves to (its relay), once.
 * After either is welcomed, a close is a close: the host reconnects as it would for one route.
 */
export function failoverTransport(
  primary: DeviceTransport,
  fallback: () => Promise<DeviceTransport | undefined>,
  routed?: (route: "primary" | "fallback") => void,
): DeviceTransport {
  let current: DeviceTransport | undefined;
  let opening = 0;
  return {
    open(events) {
      const attempt = ++opening;
      let welcomed = false;
      const follow = (transport: DeviceTransport, route: "primary" | "fallback") => {
        current = transport;
        transport.open({
          ready: () => {
            if (attempt !== opening) return;
            welcomed = true;
            routed?.(route);
            events.ready();
          },
          message: (data) => {
            if (attempt === opening) events.message(data);
          },
          close: () => {
            if (attempt !== opening) return;
            if (welcomed || route === "fallback") return void events.close();
            void fallback().then(
              (next) => {
                if (attempt !== opening) return;
                if (next) follow(next, "fallback");
                else events.close();
              },
              () => {
                if (attempt === opening) events.close();
              },
            );
          },
          ...(events.limited
            ? {
                limited: (error) => {
                  if (attempt === opening) events.limited?.(error);
                },
              }
            : {}),
        });
      };
      follow(primary, "primary");
    },
    send(message) {
      if (!current) throw new Error("Device channel is not open");
      return current.send(message);
    },
    close() {
      opening++;
      const closing = current;
      current = undefined;
      closing?.close();
    },
  };
}
