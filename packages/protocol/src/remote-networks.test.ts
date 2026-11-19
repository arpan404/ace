import { expect, test } from "vitest";
import { RemoteAccessStatus } from "./remote.ts";

const off = { state: "off" };

test("a status from a newer daemon with a network state this app doesn't know still reads", () => {
  const status = RemoteAccessStatus.parse({
    enabled: true,
    transport: "tailscale",
    listenOverride: null,
    relayOverride: false,
    networks: {
      lan: off,
      tailscale: { state: "on", address: "https://mac.tail.ts.net:4243" },
      relay: off,
      account: { state: "reconnecting-soon", error: "Relay restarting" },
    },
  });
  // The unknown state is kept as sent, and the other networks are intact.
  expect(status.networks?.account).toEqual({
    state: "reconnecting-soon",
    error: "Relay restarting",
  });
  expect(status.networks?.tailscale.state).toBe("on");
});
