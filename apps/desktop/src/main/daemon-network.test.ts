import { expect, it } from "vitest";
import { DaemonNetwork } from "./daemon-network.ts";

it("a selected remote host can pair over HTTPS and reconnect over WSS while other hosts stay blocked", () => {
  const network = new DaemonNetwork();
  expect(network.allows("https://selected.example/v1/pair", "xhr")).toBe(false);
  network.authorize("wss://selected.example/");
  expect(network.allows("https://selected.example/v1/pair", "xhr")).toBe(true);
  expect(network.allows("https://selected.example/v1/tickets", "xhr")).toBe(true);
  expect(network.allows("wss://selected.example/", "webSocket")).toBe(true);
  expect(network.allows("https://unselected.example/v1/tickets", "xhr")).toBe(false);
  expect(network.allows("wss://unselected.example/", "webSocket")).toBe(false);
});
it("unsafe remote origins cannot authorize cleartext or embedded credentials", () => {
  const network = new DaemonNetwork();
  for (const url of [
    "ws://remote.example/",
    "wss://user:secret@remote.example/",
    "wss://remote.example/path",
  ])
    expect(() => network.authorize(url)).toThrow();
  expect(network.allows("ws://remote.example/", "webSocket")).toBe(false);
});
