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
import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";

const values = ["legacy", "auto"] as const;
// `delivery` is only ever `auto` (X3): the daemon has no deliverer of its own.
const settingsTable: MediaSettings[] = values.flatMap((encode) =>
  values.flatMap((recordings) =>
    values.map((stills) => ({ encode, delivery: "auto" as const, recordings, stills })),
  ),
);
const healths: MediaHealth[] = ["healthy", "restarting", "unavailable"];
const everything: RouteCapabilities = {
  ingest: sourceKinds,
  recordings: true,
  stills: true,
  delivery: true,
};
const capabilityTable: [string, RouteCapabilities][] = [
  ["all present", everything],
  ["all absent", { ingest: [], recordings: false, stills: false, delivery: false }],
  ["this build", builtRouteCapabilities],
  ["no ingest", { ...everything, ingest: [] }],
  ["tab ingest only", { ...everything, ingest: ["tab"] }],
  ["no recorder", { ...everything, recordings: false }],
  ["no stills", { ...everything, stills: false }],
  ["no delivery", { ...everything, delivery: false }],
];

const consumers = (route: SourceRoute) => [route.recorder, route.stills];

describe("every setting combination × capabilities is a complete route", () => {
  for (const health of healths)
    it(`while ace-media is ${health}`, () => {
      for (const settings of settingsTable)
        for (const [capabilityName, capabilities] of capabilityTable) {
          const routes = mediaRoutes(settings, health, capabilities);
          for (const kind of sourceKinds) {
            const route = routes[kind];
            const where = `${JSON.stringify(settings)}, ${capabilityName}, ${kind}: ${JSON.stringify(route)}`;
            // Every consumer has an input: frames in the daemon for a legacy one, in ace-media
            // for ace-media's. ace-media delivers only what its producer streams into it.
            if (route.deliverer === "ace-media") expect(route.producer, where).toBe("ace-media");
            for (const consumer of consumers(route)) {
              const inDaemon = route.producer === "daemon" || route.egress;
              const inMedia = route.producer === "ace-media" || route.tee;
              expect(consumer === "legacy" ? inDaemon : inMedia, where).toBe(true);
            }
            expect(route.tee && route.egress, where).toBe(false);
            // Nothing runs in ace-media unless it is healthy and asked for.
            if (health !== "healthy") {
              expect(route.producer, where).toBe("daemon");
              expect(route.deliverer, where).toBe("none");
              expect(consumers(route), where).toEqual(["legacy", "legacy"]);
            }
            // ace-media takes a part only when its setting is auto and the build can do it.
            const asked = {
              deliverer: capabilities.delivery,
              recorder: settings.recordings === "auto" && capabilities.recordings,
              stills: settings.stills === "auto" && capabilities.stills,
            };
            for (const part of ["deliverer", "recorder", "stills"] as const)
              if (route[part] === "ace-media") expect(asked[part], where).toBe(true);
            if (route.producer === "ace-media") {
              expect(settings.encode, where).toBe("auto");
              expect(capabilities.ingest, where).toContain(kind);
            }
          }
        }
    });
});

it("tee and egress follow the plan's table (healthy, every capability)", () => {
  // [encode, delivery, recordings, stills] → [producer, tee, egress]
  const rows: [MediaSettings, [SourceRoute["producer"], boolean, boolean]][] = [
    [
      { encode: "legacy", delivery: "auto", recordings: "legacy", stills: "legacy" },
      ["daemon", false, false],
    ],
    [
      { encode: "legacy", delivery: "auto", recordings: "legacy", stills: "auto" },
      ["daemon", true, false],
    ],
    [
      { encode: "legacy", delivery: "auto", recordings: "auto", stills: "auto" },
      ["daemon", true, false],
    ],
    [
      { encode: "auto", delivery: "auto", recordings: "legacy", stills: "auto" },
      ["ace-media", false, true],
    ],
    [
      { encode: "auto", delivery: "auto", recordings: "auto", stills: "legacy" },
      ["ace-media", false, true],
    ],
    [
      { encode: "auto", delivery: "auto", recordings: "auto", stills: "auto" },
      ["ace-media", false, false],
    ],
  ];
  for (const [settings, expected] of rows) {
    const route = mediaRoutes(settings, "healthy", everything).tab;
    expect([route.producer, route.tee, route.egress], JSON.stringify(settings)).toEqual(expected);
  }
});

function healthy(settings: MediaSettings, capabilities = everything): SourceRoute {
  return mediaRoutes(settings, "healthy", capabilities).screen;
}

describe("named routes", () => {
  it("encode legacy keeps the producer on the daemon, where nobody delivers its pictures", () => {
    expect(
      healthy({ encode: "legacy", delivery: "auto", recordings: "legacy", stills: "legacy" }),
    ).toEqual({
      producer: "daemon",
      tee: false,
      egress: false,
      deliverer: "none",
      recorder: "legacy",
      stills: "legacy",
    });
  });

  it("encode and delivery on auto with recordings and stills legacy feed the daemon's recorder and still maker through egress", () => {
    expect(
      healthy({ encode: "auto", delivery: "auto", recordings: "legacy", stills: "legacy" }),
    ).toEqual({
      producer: "ace-media",
      tee: false,
      egress: true,
      deliverer: "ace-media",
      recorder: "legacy",
      stills: "legacy",
    });
  });

  it("encode legacy with recordings auto tees into ace-media", () => {
    expect(
      healthy({ encode: "legacy", delivery: "auto", recordings: "auto", stills: "legacy" }),
    ).toMatchObject({ producer: "daemon", tee: true, egress: false, recorder: "ace-media" });
  });

  it("everything auto needs neither tee nor egress", () => {
    expect(
      healthy({ encode: "auto", delivery: "auto", recordings: "auto", stills: "auto" }),
    ).toMatchObject({ producer: "ace-media", tee: false, egress: false });
  });

  it("a kind whose producer can't stream into ace-media stays on the daemon, teeing for ace-media's recorder, and nobody delivers it", () => {
    const settings: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "auto",
      stills: "legacy",
    };
    const routes = mediaRoutes(settings, "healthy", { ...everything, ingest: ["tab"] });
    expect(routes.tab).toMatchObject({ producer: "ace-media", egress: true });
    expect(routes.simulator).toMatchObject({
      producer: "daemon",
      tee: true,
      egress: false,
      deliverer: "none",
    });
  });

  it("this build streams browser producers into ace-media, which delivers them, with recordings and stills still legacy", () => {
    const auto: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "auto",
      stills: "auto",
    };
    const routes = mediaRoutes(auto, "healthy", builtRouteCapabilities);
    for (const kind of ["tab", "tab-pictures", "user-tab", "embedded"] as const)
      expect(routes[kind]).toMatchObject({
        producer: "ace-media",
        tee: false,
        egress: true,
        deliverer: "ace-media",
        recorder: "legacy",
        stills: "legacy",
      });
    for (const kind of ["screen", "simulator", "scrcpy", "emulator-frames"] as const)
      expect(routes[kind]).toMatchObject({ producer: "daemon", egress: false });
    for (const health of ["restarting", "unavailable"] as const)
      expect(mediaRoutes(auto, health, builtRouteCapabilities).tab.producer).toBe("daemon");
  });

  it("on a Mac the screen, host-encoded emulators and Simulators stream into ace-media too, Android devices everywhere, with egress feeding their legacy consumers; elsewhere they stay on the daemon", () => {
    const auto: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "auto",
      stills: "auto",
    };
    const mac = mediaRoutes(auto, "healthy", platformRouteCapabilities("darwin"));
    for (const kind of ["screen", "emulator-frames", "simulator"] as const)
      expect(mac[kind]).toEqual({
        producer: "ace-media",
        tee: false,
        egress: true,
        deliverer: "ace-media",
        recorder: "legacy",
        stills: "legacy",
      });
    for (const platform of ["darwin", "linux"])
      expect(
        mediaRoutes(auto, "healthy", platformRouteCapabilities(platform)).scrcpy,
      ).toMatchObject({ producer: "ace-media", egress: true });
    // Linux screens stream into ace-media (E2); its emulators and simulators don't.
    expect(mediaRoutes(auto, "healthy", platformRouteCapabilities("linux")).screen).toEqual(
      mac.screen,
    );
    for (const [platform, kinds] of [
      ["linux", ["emulator-frames"]],
      ["win32", ["emulator-frames", "simulator"]],
    ] as const)
      for (const kind of kinds)
        expect(
          mediaRoutes(auto, "healthy", platformRouteCapabilities(platform))[kind],
        ).toMatchObject({ producer: "daemon", egress: false });
  });

  it("on Windows the screen helper's Media Foundation video streams into ace-media, which delivers it, with egress feeding its legacy consumers", () => {
    const auto: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "legacy",
      stills: "legacy",
    };
    expect(mediaRoutes(auto, "healthy", platformRouteCapabilities("win32")).screen).toEqual({
      producer: "ace-media",
      tee: false,
      egress: true,
      deliverer: "ace-media",
      recorder: "legacy",
      stills: "legacy",
    });
    for (const health of ["restarting", "unavailable"] as const)
      expect(mediaRoutes(auto, health, platformRouteCapabilities("win32")).screen.producer).toBe(
        "daemon",
      );
  });
});

it("ace-media going away changes exactly the kinds that were routed through it", () => {
  const settings: MediaSettings = {
    encode: "auto",
    delivery: "auto",
    recordings: "legacy",
    stills: "legacy",
  };
  const capabilities = { ...builtRouteCapabilities, ingest: ["tab", "screen"] as const };
  const up = mediaRoutes(settings, "healthy", capabilities);
  const down = mediaRoutes(settings, "restarting", capabilities);
  expect(changedRoutes(up, down)).toEqual(["tab", "screen"]);
  expect(down.tab.producer).toBe("daemon");
  expect(changedRoutes(down, mediaRoutes(settings, "unavailable", capabilities))).toEqual([]);
});

describe("why a live view gets no pictures", () => {
  const auto: MediaSettings = {
    encode: "auto",
    delivery: "auto",
    recordings: "legacy",
    stills: "legacy",
  };
  it("says nothing while ace-media delivers the source", () => {
    expect(undeliveredReason("tab", auto, "healthy", everything)).toBeUndefined();
  });
  it("says why for every way ace-media can't deliver it", () => {
    const cases: [string, MediaSettings, MediaHealth, RouteCapabilities, RegExp][] = [
      ["starting or restarting", auto, "restarting", everything, /starting/],
      ["failing", auto, "unavailable", everything, /keeps failing.*Restart ace/],
      ["encode legacy", { ...auto, encode: "legacy" }, "healthy", everything, /Settings › Beta/],
      ["a kind it can't ingest", auto, "healthy", { ...everything, ingest: [] }, /can't stream/],
    ];
    for (const [name, settings, health, capabilities, said] of cases)
      expect(undeliveredReason("screen", settings, health, capabilities), name).toMatch(said);
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
