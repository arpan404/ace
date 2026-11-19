import { describe, expect, it } from "vitest";
import type { MachinePath } from "@ace/protocol";
import { PREFER_MS, machineRoutes, preferredFirst } from "./link-routes.ts";

const urlsOf = (list: { url: string }[]) => list.map((route) => route.url);

describe("a call to another machine tries every way to reach it, best first", () => {
  const saved = { origin: "https://192.168.1.4:7443/", fingerprint: "a".repeat(64) };
  const relayHostId = "A".repeat(52);
  const paths: MachinePath[] = [
    { kind: "relay", url: "wss://relay.example.com", relayHostId },
    { kind: "account", url: "wss://relay.acehq.dev", relayHostId },
    { kind: "loopback", url: "https://127.0.0.1:7443", fingerprint: "a".repeat(64) },
    { kind: "tailscale", url: "https://100.64.0.2:7443", fingerprint: "a".repeat(64) },
    { kind: "lan", url: "https://192.168.1.4:7443", fingerprint: "a".repeat(64) },
    { kind: "lan", url: "https://10.0.0.9:7443", fingerprint: "b".repeat(64) },
  ];
  it("goes linked address, Tailscale, the person's relay, then ace's relay", () => {
    expect(machineRoutes(saved, paths).map((route) => [route.kind, route.url])).toEqual([
      ["direct", "https://192.168.1.4:7443/"],
      ["direct", "https://100.64.0.2:7443"],
      ["relay", "wss://relay.example.com"],
      ["relay", "wss://relay.acehq.dev"],
    ]);
  });
  it("never tries loopback, which would reach this machine, or an address under another key", () => {
    const urls = machineRoutes(saved, paths).map((route) => route.url);
    expect(urls).not.toContain("https://127.0.0.1:7443");
    expect(urls).not.toContain("https://10.0.0.9:7443");
  });
  it("marks only ace's relay as needing an account grant", () => {
    const relays = machineRoutes(saved, paths).filter((route) => route.kind === "relay");
    expect(relays.map((route) => route.kind === "relay" && route.hosted)).toEqual([false, true]);
  });
  it("tries the relay a machine was linked through before relays it only announced", () => {
    const linked = { ...saved, relay: { url: "wss://own.example.com", relayHostId } };
    const relays = machineRoutes(linked, paths).filter((route) => route.kind === "relay");
    expect(relays.map((route) => route.url)).toEqual([
      "wss://own.example.com",
      "wss://relay.example.com",
      "wss://relay.acehq.dev",
    ]);
  });
  it("reaches a machine linked through a relay only, and its announced addresses under their own key", () => {
    const routes = machineRoutes({ relay: { url: "wss://own.example.com", relayHostId } }, paths);
    expect(routes[0]).toMatchObject({ kind: "direct", url: "https://192.168.1.4:7443" });
    expect(routes.map((route) => route.url)).not.toContain("https://127.0.0.1:7443");
    expect(routes.find((route) => route.kind === "relay")?.url).toBe("wss://own.example.com");
  });
  it("still has the linked address when the machine never said what else it serves", () => {
    expect(machineRoutes(saved, [])).toHaveLength(1);
  });
});

describe("the route that answered last is tried first for a while", () => {
  const relayHostId = "A".repeat(52);
  const routes = machineRoutes(
    {
      origin: "https://192.168.1.4:7443/",
      fingerprint: "a".repeat(64),
      relay: { url: "wss://own.example.com", relayHostId },
    },
    [{ kind: "account", url: "wss://relay.acehq.dev", relayHostId }],
  );
  it("puts a relay that answered ahead of a linked address that didn't", () => {
    const preferred = { url: "wss://own.example.com", kind: "relay" as const, at: 1000 };
    expect(urlsOf(preferredFirst(routes, preferred, 1000 + PREFER_MS - 1))).toEqual([
      "wss://own.example.com",
      "https://192.168.1.4:7443/",
      "wss://relay.acehq.dev",
    ]);
  });
  it("goes back to the usual order once that answer is old", () => {
    const preferred = { url: "wss://own.example.com", kind: "relay" as const, at: 1000 };
    expect(urlsOf(preferredFirst(routes, preferred, 1000 + PREFER_MS))).toEqual(urlsOf(routes));
  });
  it("keeps the usual order when the route that answered is gone", () => {
    const preferred = { url: "wss://gone.example.com", kind: "relay" as const, at: 1000 };
    expect(urlsOf(preferredFirst(routes, preferred, 1000))).toEqual(urlsOf(routes));
  });
});
