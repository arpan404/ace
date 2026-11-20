import { describe, expect, test } from "vitest";
import {
  isLoopbackHost,
  listenPorts,
  loopbackPort,
  loopbackProblemOf,
  loopbackProblemWords,
  maxListenedPorts,
  nextLoopbackHold,
  noLoopbackHold,
  type LoopbackHold,
  type LoopbackHoldEvent,
} from "./device-loopback.ts";

describe("which pages reach the machine's localhost", () => {
  test.each([
    ["localhost", true],
    ["LOCALHOST", true],
    ["app.localhost", true],
    ["127.0.0.1", true],
    ["127.12.0.9", true],
    ["[::1]", true],
    ["localhost.", true],
    ["128.0.0.1", false],
    ["127.0.0.256", false],
    ["localhost.example.com", false],
    ["example.com", false],
    ["192.168.1.2", false],
    ["[::2]", false],
  ])("%s is loopback: %s", (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });

  test.each([
    ["http://localhost:3000/settings", 3000],
    ["http://[::1]:5173/", 5173],
    ["http://app.localhost/", 80],
    ["https://localhost/", 443],
    ["https://example.com:3000/", undefined],
    ["ws://localhost:3000/", undefined],
    ["about:blank", undefined],
    ["not a url", undefined],
  ])("%s listens on %s", (url, port) => {
    expect(loopbackPort(url)).toBe(port);
  });
});

describe("which ports the phone listens on", () => {
  test.each([
    {
      name: "the machine's ports and the page's own, ascending",
      input: { machinePorts: [5173, 3000], pagePorts: [8080], busy: new Set<number>() },
      ports: [3000, 5173, 8080],
    },
    {
      name: "the page's port before discovery reports it",
      input: { machinePorts: [], pagePorts: [3000], busy: new Set<number>() },
      ports: [3000],
    },
    {
      name: "a port busy on the phone is left out",
      input: { machinePorts: [3000, 4000], pagePorts: [3000], busy: new Set([3000]) },
      ports: [4000],
    },
    {
      name: "a port both lists name is listened on once",
      input: { machinePorts: [3000], pagePorts: [3000, 3000], busy: new Set<number>() },
      ports: [3000],
    },
    {
      name: "invalid ports are dropped",
      input: { machinePorts: [0, 70_000, 3.5], pagePorts: [-1], busy: new Set<number>() },
      ports: [],
    },
  ])("$name", ({ input, ports }) => {
    expect(listenPorts(input)).toEqual(ports);
  });

  test("past the cap, the pages' ports are kept and the machine's highest go", () => {
    const machinePorts = Array.from({ length: 100 }, (_, index) => 1000 + index);
    const ports = listenPorts({ machinePorts, pagePorts: [9999], busy: new Set() });
    expect(ports).toHaveLength(maxListenedPorts);
    expect(ports).toContain(9999);
    expect(ports).toContain(1000);
    expect(ports).not.toContain(1099);
  });
});

describe("which machine holds the ports", () => {
  const run = (events: LoopbackHoldEvent[]): LoopbackHold =>
    events.reduce(nextLoopbackHold, noLoopbackHold);

  test.each<[string, LoopbackHoldEvent[], boolean]>([
    ["a device tab in front takes the ports", [{ kind: "tabs", count: 1 }, { kind: "front" }], true],
    ["coming to the front with no device tab takes nothing", [{ kind: "front" }], false],
    [
      "another machine's tab coming to the front moves them away",
      [{ kind: "tabs", count: 1 }, { kind: "front" }, { kind: "released" }],
      false,
    ],
    [
      "they come back when this machine's tab is in front again",
      [{ kind: "tabs", count: 2 }, { kind: "front" }, { kind: "released" }, { kind: "front" }],
      true,
    ],
    [
      "closing one of two tabs keeps them",
      [{ kind: "tabs", count: 2 }, { kind: "front" }, { kind: "tabs", count: 1 }],
      true,
    ],
    [
      "closing the last tab lets them go",
      [{ kind: "tabs", count: 1 }, { kind: "front" }, { kind: "tabs", count: 0 }],
      false,
    ],
    [
      "a new tab after the last one closed waits for the front again",
      [{ kind: "tabs", count: 1 }, { kind: "front" }, { kind: "tabs", count: 0 }, { kind: "tabs", count: 1 }],
      false,
    ],
  ])("%s", (_, events, holding) => {
    expect(run(events).holding).toBe(holding);
  });
});

describe("what a failed page says", () => {
  test("each refusal names its cause, and the port where it matters", () => {
    expect(loopbackProblemWords("busy", 3000)).toContain("port 3000");
    expect(loopbackProblemWords("nothing", 5173)).toBe("Nothing is running on port 5173 on the machine.");
    expect(loopbackProblemWords("tunnel_off", 3000)).toContain("Remote access settings");
  });

  test("an unknown refusal code reads as the machine being offline", () => {
    expect(loopbackProblemOf("tunnel_port_refused")).toBe("tunnel_port_refused");
    expect(loopbackProblemOf("something_new")).toBe("offline");
  });
});
