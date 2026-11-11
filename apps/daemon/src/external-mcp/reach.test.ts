import { expect, test } from "vitest";
import {
  loopbackBase,
  reachEndpoints,
  relayBase,
  tailscaleBase,
  type ReachFacts,
} from "./reach.ts";

const on = { tailscale: true, relay: true, custom: "https://ace.example.com" };
const tailnet = { name: "studio.tail1.ts.net", port: 4443 };
const reached: ReachFacts = {
  tailscale: () => tailnet,
  relay: () => ({ origin: "https://relay.example", hostId: "host-1" }),
};

test("loopback requests are served at their own address or the person's public URL by Host", () => {
  expect(loopbackBase("127.0.0.1:4100", 4100, null)).toEqual({
    path: "local",
    url: "http://127.0.0.1:4100",
  });
  expect(loopbackBase("LOCALHOST:4100", 4100, null)?.url).toBe("http://localhost:4100");
  expect(loopbackBase("ace.example.com", 4100, on.custom)).toEqual({
    path: "custom",
    url: "https://ace.example.com",
  });
  for (const host of ["127.0.0.1:4101", "ace.example.com", "evil.example", null])
    expect(loopbackBase(host, 4100, null), String(host)).toBeUndefined();
});

test("the Tailscale listener serves outside clients only at the ts.net name, with the setting on", () => {
  const asked = { host: "studio.tail1.ts.net:4443", servername: "studio.tail1.ts.net" };
  expect(tailscaleBase(asked, tailnet, on)).toEqual({
    path: "tailscale",
    url: "https://studio.tail1.ts.net:4443",
  });
  expect(tailscaleBase(asked, tailnet, { ...on, tailscale: false })).toBeUndefined();
  expect(tailscaleBase(asked, { problem: "No certificate yet." }, on)).toBeUndefined();
  expect(tailscaleBase({ ...asked, servername: null }, tailnet, on)).toBeUndefined();
  expect(tailscaleBase({ ...asked, host: "100.64.0.2:4443" }, tailnet, on)).toBeUndefined();
});

test("a relay base needs a host prefix and a bare origin", () => {
  expect(relayBase({ origin: "https://relay.example", prefix: "/m/host-1" })?.url).toBe(
    "https://relay.example/m/host-1",
  );
  expect(relayBase({ origin: "https://relay.example/x", prefix: "/m/host-1" })).toBeUndefined();
  expect(relayBase({ origin: "https://relay.example", prefix: "/m/../x" })).toBeUndefined();
});

test("endpoints give each path's URL when it serves and why not when it can't", () => {
  expect(reachEndpoints("http://127.0.0.1:4100/mcp", reached, on)).toEqual([
    { path: "local", url: "http://127.0.0.1:4100/mcp", on: true },
    { path: "tailscale", url: "https://studio.tail1.ts.net:4443/mcp", on: true },
    { path: "relay", url: "https://relay.example/m/host-1/mcp", on: true },
    { path: "custom", url: "https://ace.example.com/mcp", on: true },
  ]);
  const stuck: ReachFacts = {
    tailscale: () => ({ problem: "No certificate yet." }),
    relay: () => ({ problem: "Signed out." }),
  };
  expect(reachEndpoints("http://127.0.0.1:4100/mcp", stuck, on).slice(1, 3)).toEqual([
    { path: "tailscale", url: null, on: true, problem: "No certificate yet." },
    { path: "relay", url: null, on: true, problem: "Signed out." },
  ]);
});
