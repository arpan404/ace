import { describe, expect, it } from "vitest";
import { DEFAULT_MANAGED_RELAY_URL } from "@ace/contracts";

import { resolveConfiguredRelayWebSocketUrl, validateRelayWebSocketUrl } from "./relay";

describe("relay", () => {
  it("accepts secure relay URLs", () => {
    expect(validateRelayWebSocketUrl("wss://relay.example.com/v1/ws")).toBe(
      "wss://relay.example.com/v1/ws",
    );
  });

  it("rejects public insecure relay URLs", () => {
    expect(() => validateRelayWebSocketUrl("ws://relay.example.com/v1/ws")).toThrow(
      /Insecure relay URLs require/,
    );
  });

  it("allows localhost insecure relay URLs when explicitly enabled", () => {
    expect(
      validateRelayWebSocketUrl("ws://127.0.0.1:8788/v1/ws", {
        allowInsecureLocalUrls: true,
      }),
    ).toBe("ws://127.0.0.1:8788/v1/ws");
  });

  it("resolves relay URL precedence from explicit to env to settings to default", () => {
    expect(
      resolveConfiguredRelayWebSocketUrl({
        explicitRelayUrl: "wss://explicit.example.com/v1/ws",
        envRelayUrl: "wss://env.example.com/v1/ws",
        persistedRelayUrl: "wss://settings.example.com/v1/ws",
      }),
    ).toBe("wss://explicit.example.com/v1/ws");

    expect(
      resolveConfiguredRelayWebSocketUrl({
        envRelayUrl: "wss://env.example.com/v1/ws",
        persistedRelayUrl: "wss://settings.example.com/v1/ws",
      }),
    ).toBe("wss://env.example.com/v1/ws");

    expect(
      resolveConfiguredRelayWebSocketUrl({
        persistedRelayUrl: "wss://settings.example.com/v1/ws",
      }),
    ).toBe("wss://settings.example.com/v1/ws");

    expect(resolveConfiguredRelayWebSocketUrl()).toBe(DEFAULT_MANAGED_RELAY_URL);
  });
});
