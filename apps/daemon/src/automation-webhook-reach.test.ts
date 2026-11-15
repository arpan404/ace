import { describe, expect, it } from "vitest";
import { noWayOn, webhookState, type WebhookWays } from "./automation-webhook-reach.ts";

const hook = "0123456789abcdef0123456789abcdef";
const off: WebhookWays = { custom: { on: false }, tailscale: { on: false }, relay: { on: false } };

describe("a webhook's addresses", () => {
  it("has none, and no problem, before its secret exists", () => {
    expect(webhookState(undefined, { ...off, relay: { on: true, base: "https://c/m/h" } })).toEqual(
      { active: false, path: null, url: null, urls: [] },
    );
  });

  it("with every way off, says to turn one on", () => {
    expect(webhookState(hook, off)).toMatchObject({ active: true, url: null, problem: noWayOn });
  });

  it("lists each way that serves, those ace cloud doesn't carry first", () => {
    const state = webhookState(hook, {
      custom: { on: true, base: "https://hooks.example.com" },
      tailscale: { on: true, base: "https://mac.tail.ts.net" },
      relay: { on: true, base: "https://cloud.acehq.dev/m/host" },
    });
    expect(state.urls.map((entry) => entry.via)).toEqual(["custom", "tailscale", "relay"]);
    expect(state.url).toBe(`https://hooks.example.com/hooks/${hook}`);
    expect(state.problem).toBeUndefined();
  });

  it("leaves out a way that's on but can't serve, and says why when none can", () => {
    const tailscale = { on: true as const, problem: "Turn on Tailscale in Remote access." };
    expect(
      webhookState(hook, { ...off, tailscale, relay: { on: true, base: "https://c/m/h" } }),
    ).toMatchObject({ url: `https://c/m/h/hooks/${hook}`, urls: [{ via: "relay" }] });
    expect(webhookState(hook, { ...off, tailscale })).toMatchObject({
      url: null,
      urls: [],
      problem: tailscale.problem,
    });
  });
});
