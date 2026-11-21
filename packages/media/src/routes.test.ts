import { describe, expect, it } from "vitest";
import {
  builtRouteCapabilities,
  platformRouteCapabilities,
  changedRoutes,
  mediaRoutes,
  sourceKinds,
  undeliveredReason,
  type RouteCapabilities,
} from "./routes.ts";
import type { MediaHealth } from "./supervision-policy.ts";

const healths: MediaHealth[] = ["healthy", "restarting", "unavailable"];
const everything: RouteCapabilities = { ingest: sourceKinds, delivery: true };
const capabilityTable: [string, RouteCapabilities][] = [
  ["all present", everything],
  ["all absent", { ingest: [], delivery: false }],
  ["this build", builtRouteCapabilities],
  ["no ingest", { ...everything, ingest: [] }],
  ["tab ingest only", { ...everything, ingest: ["tab"] }],
  ["no delivery", { ...everything, delivery: false }],
];

describe("every capability set routes every producer into ace-media or nowhere", () => {
  for (const health of healths)
    it(`while ace-media is ${health}`, () => {
      for (const [capabilityName, capabilities] of capabilityTable) {
        const routes = mediaRoutes(health, capabilities);
        for (const kind of sourceKinds) {
          const route = routes[kind];
          const where = `${capabilityName}, ${kind}: ${JSON.stringify(route)}`;
          // ace-media delivers only what its producer streams into it (X3).
          if (route.deliverer === "ace-media") expect(route.producer, where).toBe("ace-media");
          // Every streaming source comes back on egress: the recording feed takes it there.
          expect(route.egress, where).toBe(route.producer === "ace-media");
          // Nothing streams or is delivered unless ace-media is healthy (X2: no daemon path).
          if (health !== "healthy") {
            expect(route.producer, where).toBe("none");
            expect(route.deliverer, where).toBe("none");
          }
          if (route.deliverer === "ace-media") expect(capabilities.delivery, where).toBe(true);
          // Every producer that can stream into a healthy ace-media does.
          expect(route.producer === "ace-media", where).toBe(
            health === "healthy" && capabilities.ingest.includes(kind),
          );
        }
      }
    });
});

describe("named routes", () => {
  it("a producer streams into ace-media, which delivers it", () => {
    expect(mediaRoutes("healthy", everything).screen).toEqual({
      producer: "ace-media",
      egress: true,
      deliverer: "ace-media",
    });
  });

  it("a kind whose producer can't stream into ace-media streams nowhere, and nobody delivers it", () => {
    const routes = mediaRoutes("healthy", {
      ...everything,
      ingest: ["tab"],
    });
    expect(routes.tab).toMatchObject({ producer: "ace-media", egress: true });
    expect(routes.simulator).toMatchObject({
      producer: "none",
      egress: false,
      deliverer: "none",
    });
  });

  it("this build streams browser producers into ace-media, which delivers them", () => {
    const routes = mediaRoutes("healthy", builtRouteCapabilities);
    for (const kind of ["tab", "tab-pictures", "user-tab", "embedded"] as const)
      expect(routes[kind]).toEqual({
        producer: "ace-media",
        egress: true,
        deliverer: "ace-media",
      });
    for (const kind of ["screen", "simulator", "scrcpy", "emulator-frames"] as const)
      expect(routes[kind]).toMatchObject({ producer: "none", egress: false });
    for (const health of ["restarting", "unavailable"] as const)
      expect(mediaRoutes(health, builtRouteCapabilities).tab.producer).toBe("none");
  });

  it("on a Mac the screen, host-encoded emulators and Simulators stream into ace-media too, Android devices everywhere; elsewhere they stream nowhere", () => {
    const mac = mediaRoutes("healthy", platformRouteCapabilities("darwin"));
    for (const kind of ["screen", "emulator-frames", "simulator"] as const)
      expect(mac[kind]).toEqual({
        producer: "ace-media",
        egress: true,
        deliverer: "ace-media",
      });
    for (const platform of ["darwin", "linux"])
      expect(mediaRoutes("healthy", platformRouteCapabilities(platform)).scrcpy).toMatchObject({
        producer: "ace-media",
        egress: true,
      });
    // Linux screens stream into ace-media (E2); its emulators and simulators don't.
    expect(mediaRoutes("healthy", platformRouteCapabilities("linux")).screen).toEqual(mac.screen);
    for (const [platform, kinds] of [
      ["linux", ["emulator-frames"]],
      ["win32", ["emulator-frames", "simulator"]],
    ] as const)
      for (const kind of kinds)
        expect(mediaRoutes("healthy", platformRouteCapabilities(platform))[kind]).toMatchObject({
          producer: "none",
          egress: false,
        });
  });

  it("on Windows the screen helper's Media Foundation video streams into ace-media, which delivers it, egress feeding recordings", () => {
    expect(mediaRoutes("healthy", platformRouteCapabilities("win32")).screen).toEqual({
      producer: "ace-media",
      egress: true,
      deliverer: "ace-media",
    });
  });

  it("delivery on auto is ace-media's, with egress still feeding recordings", () => {
    expect(mediaRoutes("healthy", everything).tab).toEqual({
      producer: "ace-media",
      egress: true,
      deliverer: "ace-media",
    });
  });

  it("a kind ace-media can't take streams nowhere, never to the daemon", () => {
    const routes = mediaRoutes("healthy", { ...everything, ingest: ["tab"] });
    expect(routes.tab.producer).toBe("ace-media");
    expect(routes.simulator).toMatchObject({ producer: "none", egress: false });
  });

  it("every platform streams its browsers, screens (JPEG-only ones as pictures) and Android devices into ace-media; a Mac its Simulators and host-encoded emulators too", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const routes = mediaRoutes("healthy", platformRouteCapabilities(platform));
      for (const kind of [
        "tab",
        "tab-pictures",
        "user-tab",
        "embedded",
        "screen",
        "screen-pictures",
        "scrcpy",
      ] as const)
        expect(routes[kind].producer, `${platform} ${kind}`).toBe("ace-media");
      for (const kind of ["simulator", "emulator-frames"] as const)
        expect(routes[kind].producer, `${platform} ${kind}`).toBe(
          platform === "darwin" ? "ace-media" : "none",
        );
    }
  });
});

it("ace-media going away changes exactly the kinds that were routed through it", () => {
  const capabilities = { ...builtRouteCapabilities, ingest: ["tab", "screen"] as const };
  const up = mediaRoutes("healthy", capabilities);
  const down = mediaRoutes("restarting", capabilities);
  expect(changedRoutes(up, down)).toEqual(["tab", "screen"]);
  expect(down.tab.producer).toBe("none");
  expect(changedRoutes(down, mediaRoutes("unavailable", capabilities))).toEqual([]);
});

describe("why a live view gets no pictures", () => {
  it("says nothing while ace-media delivers the source", () => {
    expect(undeliveredReason("tab", "healthy", everything)).toBeUndefined();
  });
  it("says why for every way ace-media can't deliver it", () => {
    const cases: [string, MediaHealth, RouteCapabilities, RegExp][] = [
      ["starting or restarting", "restarting", everything, /starting/],
      ["failing", "unavailable", everything, /keeps failing.*Restart ace/],
      ["a kind it can't ingest", "healthy", { ...everything, ingest: [] }, /can't stream/],
    ];
    for (const [name, health, capabilities, said] of cases)
      expect(undeliveredReason("screen", health, capabilities), name).toMatch(said);
  });
  it("gives a reason for every combination whose source isn't delivered, and none otherwise", () => {
    for (const health of healths)
      for (const [, capabilities] of capabilityTable)
        for (const kind of sourceKinds) {
          const route = mediaRoutes(health, capabilities)[kind];
          const reason = undeliveredReason(kind, health, capabilities);
          expect(reason === undefined, `${health} ${kind}`).toBe(route.deliverer === "ace-media");
        }
  });
});
