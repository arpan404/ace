import { afterEach, describe, expect, it } from "vitest";
import type { TunnelDialer } from "@ace/client/machine-tunnel";
import { MachineTunnels, type PathRequest } from "./tunnels.ts";

/*
 * Who holds a machine's tunnel and its credential in the main process (ADR 0194). The dialer
 * is the network edge: its pinned ticket exchange says which credential each dial presents, and
 * a direct socket is never reached here because the exchange is refused.
 */

const first = "1".repeat(64);
const second = "2".repeat(64);
const pin = "f".repeat(64);
const path = (token: string, url = "wss://192.168.1.4:7443/"): PathRequest => ({
  key: `lan:${url}`,
  target: { kind: "direct", url, fingerprint: pin },
  expectedHostId: "host-b",
  deviceId: "device-1",
  token,
});

const timers = new Set<ReturnType<typeof setTimeout>>();
afterEach(() => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
});
const schedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  timers.add(timer);
  return () => clearTimeout(timer);
};

/** Tunnels whose dials are seen at the ticket exchange: which pin, and which token. */
function setUp() {
  const exchanges: { fingerprint: string; authorization: string }[] = [];
  const sockets: string[] = [];
  const idle: string[] = [];
  const dialer: TunnelDialer = {
    directFetch: (fingerprint) => async (_url, init) => {
      const headers = new Headers(init.headers);
      exchanges.push({ fingerprint, authorization: headers.get("authorization") ?? "" });
      return new Response(null, { status: 503 });
    },
    direct: (url) => {
      sockets.push(url);
      throw new Error("no socket in this test");
    },
    relay: () => {
      throw new Error("no relay in this test");
    },
  };
  const tunnels = new MachineTunnels({
    dialer,
    schedule,
    idle: (machineId) => idle.push(machineId),
  });
  return { tunnels, exchanges, sockets, idle };
}

describe("a machine's tunnel in the main process", () => {
  it("dials the window's path under its pin, trading the token for a ticket first", async () => {
    const { tunnels, exchanges, sockets } = setUp();
    tunnels.publish(1, "m", path(first));
    tunnels.tunnel("m");
    await expect.poll(() => exchanges.length).toBeGreaterThan(0);
    expect(exchanges[0]).toEqual({ fingerprint: pin, authorization: `Bearer ${first}` });
    // The exchange failed, so no socket was opened, let alone one carrying the token.
    expect(sockets).toEqual([]);
    tunnels.close();
  });

  it("uses a replaced credential for the same address from the next dial", async () => {
    const { tunnels, exchanges } = setUp();
    tunnels.publish(1, "m", path(first));
    tunnels.tunnel("m");
    await expect.poll(() => exchanges.length).toBeGreaterThan(0);
    tunnels.publish(1, "m", path(second));
    await expect
      .poll(() => exchanges.some((exchange) => exchange.authorization === `Bearer ${second}`))
      .toBe(true);
    tunnels.close();
  });

  it("lets the machine go, credential and tunnel, when the window says it is offline", () => {
    const { tunnels, idle } = setUp();
    tunnels.publish(1, "m", path(first));
    expect(tunnels.tunnel("m")).toBeDefined();
    tunnels.publish(1, "m", undefined);
    expect(tunnels.holds("m")).toBe(false);
    expect(tunnels.tunnel("m")).toBeUndefined();
    expect(idle).toEqual(["m"]);
  });

  it("keeps the machine while another window still leases it, then lets it go", () => {
    const { tunnels, idle } = setUp();
    tunnels.publish(1, "m", path(first));
    tunnels.publish(2, "m", path(first));
    tunnels.release(1, "m");
    expect(tunnels.holds("m")).toBe(true);
    expect(idle).toEqual([]);
    tunnels.forgetSender(2);
    expect(tunnels.holds("m")).toBe(false);
    expect(idle).toEqual(["m"]);
  });

  it("ends every lease a window held when it reloads or goes away", () => {
    const { tunnels, idle } = setUp();
    tunnels.publish(1, "a", path(first));
    tunnels.publish(1, "b", path(first, "wss://10.0.0.2:7443/"));
    tunnels.forgetSender(1);
    expect([tunnels.holds("a"), tunnels.holds("b")]).toEqual([false, false]);
    expect(idle.toSorted()).toEqual(["a", "b"]);
  });

  it("follows the window that told its path last", async () => {
    const { tunnels, exchanges } = setUp();
    tunnels.publish(1, "m", path(first));
    tunnels.publish(2, "m", path(second));
    tunnels.tunnel("m");
    await expect.poll(() => exchanges.length).toBeGreaterThan(0);
    expect(exchanges[0]?.authorization).toBe(`Bearer ${second}`);
    tunnels.close();
  });
});
