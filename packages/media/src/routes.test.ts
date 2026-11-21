import { describe, expect, it } from "vitest";
import {
  builtRouteCapabilities,
  platformRouteCapabilities,
  changedRoutes,
  mediaRoutes,
  sourceKinds,
  undeliveredReason,
  type RouteCapabilities,
  type SourceRoute,
} from "./routes.ts";
import {
  defaultMediaSettings,
  type MediaHealth,
  type MediaSettings,
} from "./supervision-policy.ts";

const values = ["legacy", "auto"] as const;
const settingsOf = (encode: "auto" | "legacy"): MediaSettings => ({
  ...defaultMediaSettings,
  encode,
});
// Recordings and stills have no legacy value since X1, nor delivery since X3: only encode chooses.
const settingsTable: MediaSettings[] = values.map((encode) => settingsOf(encode));
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

describe("every setting combination × capabilities is a complete route", () => {
  for (const health of healths)
    it(`while ace-media is ${health}`, () => {
      for (const settings of settingsTable)
        for (const [capabilityName, capabilities] of capabilityTable) {
          const routes = mediaRoutes(settings, health, capabilities);
          for (const kind of sourceKinds) {
            const route = routes[kind];
            const where = `${JSON.stringify(settings)}, ${capabilityName}, ${kind}: ${JSON.stringify(route)}`;
            const inDaemon = route.producer === "daemon" || route.egress;
            const inMedia = route.producer === "ace-media" || route.tee;
            // ace-media delivers only what its producer streams into it (X3).
            if (route.deliverer === "ace-media") expect(inMedia, where).toBe(true);
            if (route.deliverer === "ace-media") expect(route.producer, where).toBe("ace-media");
            // A recording tees what the daemon has, so the daemon always has the frames.
            expect(inDaemon, where).toBe(true);
            expect(route.tee && route.egress, where).toBe(false);
            // Nothing runs in ace-media unless it is healthy and asked for.
            if (health !== "healthy") {
              expect(route.producer, where).toBe("daemon");
              expect(route.deliverer, where).toBe("none");
            }
            if (route.deliverer === "ace-media") expect(capabilities.delivery, where).toBe(true);
            if (route.producer === "ace-media") {
              expect(settings.encode, where).toBe("auto");
              expect(capabilities.ingest, where).toContain(kind);
            }
          }
        }
    });
});

it("tee and egress follow the plan's table (healthy, every capability)", () => {
  // encode → [producer, tee, egress]. No tee feeds viewers (X3); recordings tee on their own.
  const rows: [MediaSettings, [SourceRoute["producer"], boolean, boolean]][] = [
    [settingsOf("legacy"), ["daemon", false, false]],
    // Egress stays on: a recording takes the frames in the daemon until X2.
    [settingsOf("auto"), ["ace-media", false, true]],
  ];
  for (const [settings, expected] of rows) {
    const route = mediaRoutes(settings, "healthy", everything).tab;
    expect([route.producer, route.tee, route.egress], JSON.stringify(settings)).toEqual(expected);
  }
});

describe("named routes", () => {
  it("the default settings keep the producer on the daemon, where nobody delivers its pictures", () => {
    expect(mediaRoutes(defaultMediaSettings, "healthy", everything).screen).toEqual({
      producer: "daemon",
      tee: false,
      egress: false,
      deliverer: "none",
    });
  });

  it("a kind whose producer can't stream into ace-media stays on the daemon, and nobody delivers it", () => {
    const routes = mediaRoutes(settingsOf("auto"), "healthy", {
      ...everything,
      ingest: ["tab"],
    });
    expect(routes.tab).toMatchObject({ producer: "ace-media", egress: true });
    expect(routes.simulator).toMatchObject({
      producer: "daemon",
      tee: false,
      egress: false,
      deliverer: "none",
    });
  });

  it("this build streams browser producers into ace-media, which delivers them", () => {
    const settings = settingsOf("auto");
    const routes = mediaRoutes(settings, "healthy", builtRouteCapabilities);
    for (const kind of ["tab", "tab-pictures", "user-tab", "embedded"] as const)
      expect(routes[kind]).toEqual({
        producer: "ace-media",
        tee: false,
        egress: true,
        deliverer: "ace-media",
      });
    for (const kind of ["screen", "simulator", "scrcpy", "emulator-frames"] as const)
      expect(routes[kind]).toMatchObject({ producer: "daemon", egress: false });
    for (const health of ["restarting", "unavailable"] as const)
      expect(mediaRoutes(settings, health, builtRouteCapabilities).tab.producer).toBe("daemon");
  });

  it("on a Mac the screen, host-encoded emulators and Simulators stream into ace-media too, Android devices everywhere; elsewhere they stay on the daemon", () => {
    const settings = settingsOf("auto");
    const mac = mediaRoutes(settings, "healthy", platformRouteCapabilities("darwin"));
    for (const kind of ["screen", "emulator-frames", "simulator"] as const)
      expect(mac[kind]).toEqual({
        producer: "ace-media",
        tee: false,
        egress: true,
        deliverer: "ace-media",
      });
    for (const platform of ["darwin", "linux"])
      expect(
        mediaRoutes(settings, "healthy", platformRouteCapabilities(platform)).scrcpy,
      ).toMatchObject({ producer: "ace-media", egress: true });
    // Linux screens stream into ace-media (E2); its emulators and simulators don't.
    expect(mediaRoutes(settings, "healthy", platformRouteCapabilities("linux")).screen).toEqual(
      mac.screen,
    );
    for (const [platform, kinds] of [
      ["linux", ["emulator-frames"]],
      ["win32", ["emulator-frames", "simulator"]],
    ] as const)
      for (const kind of kinds)
        expect(
          mediaRoutes(settings, "healthy", platformRouteCapabilities(platform))[kind],
        ).toMatchObject({ producer: "daemon", egress: false });
  });

  it("on Windows the screen helper's Media Foundation video streams into ace-media, which delivers it, egress feeding recordings", () => {
    const settings = settingsOf("auto");
    expect(mediaRoutes(settings, "healthy", platformRouteCapabilities("win32")).screen).toEqual({
      producer: "ace-media",
      tee: false,
      egress: true,
      deliverer: "ace-media",
    });
    for (const health of ["restarting", "unavailable"] as const)
      expect(
        mediaRoutes(settings, health, platformRouteCapabilities("win32")).screen.producer,
      ).toBe("daemon");
  });
});

it("ace-media going away changes exactly the kinds that were routed through it", () => {
  const settings = settingsOf("auto");
  const capabilities = { ...builtRouteCapabilities, ingest: ["tab", "screen"] as const };
  const up = mediaRoutes(settings, "healthy", capabilities);
  const down = mediaRoutes(settings, "restarting", capabilities);
  expect(changedRoutes(up, down)).toEqual(["tab", "screen"]);
  expect(down.tab.producer).toBe("daemon");
  expect(changedRoutes(down, mediaRoutes(settings, "unavailable", capabilities))).toEqual([]);
});

describe("why a live view gets no pictures", () => {
  const auto = settingsOf("auto");
  it("says nothing while ace-media delivers the source", () => {
    expect(undeliveredReason("tab", auto, "healthy", everything)).toBeUndefined();
  });
  it("says why for every way ace-media can't deliver it, whatever the settings", () => {
    const cases: [string, MediaHealth, RouteCapabilities, RegExp][] = [
      ["starting or restarting", "restarting", everything, /starting/],
      ["failing", "unavailable", everything, /keeps failing.*Restart ace/],
      ["a kind it can't ingest", "healthy", { ...everything, ingest: [] }, /can't stream/],
    ];
    for (const [name, health, capabilities, said] of cases)
      expect(undeliveredReason("screen", auto, health, capabilities), name).toMatch(said);
  });
  it("gives a reason for every combination whose source isn't delivered, and none otherwise", () => {
    for (const health of healths)
      for (const settings of settingsTable)
        for (const [, capabilities] of capabilityTable)
          for (const kind of sourceKinds) {
            const route = mediaRoutes(settings, health, capabilities)[kind];
            const reason = undeliveredReason(kind, settings, health, capabilities);
            expect(reason === undefined, `${health} ${kind}`).toBe(route.deliverer === "ace-media");
          }
  });
});
