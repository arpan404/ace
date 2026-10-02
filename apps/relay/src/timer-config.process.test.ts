import { expect, it } from "vitest";
import { keyPair } from "@ace/secure-channel";
import { readRelayConfig, startRelay, connectHostToRelay } from "./index.ts";

it.each([
  ["ACE_RELAY_IDLE_TIMEOUT_MS", "idleTimeoutMs"],
  ["ACE_RELAY_HANDSHAKE_TIMEOUT_MS", "handshakeTimeoutMs"],
  ["ACE_RELAY_TICKET_TIMEOUT_MS", "ticketTimeoutMs"],
] as const)("%s accepts the timer ceiling and rejects overflow", (env, limit) => {
  expect(readRelayConfig({ [env]: "2147483647" }).limits[limit]).toBe(2147483647);
  for (const value of ["2147483648", "9007199254740991"])
    expect(() => readRelayConfig({ [env]: value })).toThrow("2147483647");
});

it.each(["idleTimeoutMs", "handshakeTimeoutMs", "ticketTimeoutMs"] as const)(
  "programmatic relay %s cannot overflow timers",
  async (limit) => {
    await expect(
      startRelay({ limits: { [limit]: 2147483648 } }).then((relay) => relay.close()),
    ).rejects.toThrow("2147483647");
  },
);

it.each(["helloTimeoutMs", "handshakeTimeoutMs", "retryInitialMs", "retryMaxMs"] as const)(
  "host %s cannot overflow timers or reconnect delays",
  async (limit) => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      connectHostToRelay({
        relayUrl: "ws://127.0.0.1:1",
        hostKeys: keyPair(),
        signal: controller.signal,
        onClientChannel() {},
        limits: { [limit]: 2147483648 },
      }),
    ).rejects.toThrow("2147483647");
  },
);
