import { describe, expect, it } from "vitest";
import {
  builtRouteCapabilities,
  platformRouteCapabilities,
  changedRoutes,
  mediaRoutes,
  sourceKinds,
  type RouteCapabilities,
} from "./routes.ts";
import {
  defaultMediaSettings,
  type MediaHealth,
  type MediaSettings,
} from "./supervision-policy.ts";

// ace-media always encodes (X2) and always records and makes stills (X1): only delivery chooses.
const settingsTable: MediaSettings[] = (["legacy", "auto"] as const).map((delivery) => ({
  ...defaultMediaSettings,
  delivery,
}));
const auto: MediaSettings = { ...defaultMediaSettings, delivery: "auto" };
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

describe("every setting combination × capabilities routes every producer into ace-media or nowhere", () => {
  for (const health of healths)
    it(`while ace-media is ${health}`, () => {
      for (const settings of settingsTable)
        for (const [capabilityName, capabilities] of capabilityTable) {
          const routes = mediaRoutes(settings, health, capabilities);
          for (const kind of sourceKinds) {
            const route = routes[kind];
            const where = `${JSON.stringify(settings)}, ${capabilityName}, ${kind}: ${JSON.stringify(route)}`;
            // A producer streams only into a healthy ace-media that takes its kind; the daemon
            // has no path of its own any more.
            const streams = health === "healthy" && capabilities.ingest.includes(kind);
            expect(route.producer, where).toBe(streams ? "ace-media" : "none");
            // Every streaming source comes back on egress: the recording feed takes it there.
            expect(route.egress, where).toBe(streams);
            if (health !== "healthy") expect(route.deliverer, where).toBe("legacy");
            if (route.deliverer === "ace-media") {
              expect(settings.delivery, where).toBe("auto");
              expect(capabilities.delivery, where).toBe(true);
            }
          }
        }
    });
});

describe("named routes", () => {
  it("the default settings stream every source into ace-media and back for the daemon's viewers", () => {
    expect(mediaRoutes(defaultMediaSettings, "healthy", everything).screen).toEqual({
      producer: "ace-media",
      egress: true,
      deliverer: "legacy",
    });
  });

  it("delivery on auto is ace-media's, with egress still feeding recordings", () => {
    expect(mediaRoutes(auto, "healthy", everything).tab).toEqual({
      producer: "ace-media",
      egress: true,
      deliverer: "ace-media",
    });
  });

  it("a kind ace-media can't take streams nowhere, never to the daemon", () => {
    const routes = mediaRoutes(auto, "healthy", { ...everything, ingest: ["tab"] });
    expect(routes.tab.producer).toBe("ace-media");
    expect(routes.simulator).toMatchObject({ producer: "none", egress: false });
  });

  it("every platform streams its browsers, screens (JPEG-only ones as pictures) and Android devices into ace-media; a Mac its Simulators and host-encoded emulators too", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const routes = mediaRoutes(auto, "healthy", platformRouteCapabilities(platform));
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

it("ace-media going away stops exactly the kinds that were streaming into it", () => {
  const capabilities = { ...builtRouteCapabilities, ingest: ["tab", "screen"] as const };
  const up = mediaRoutes(defaultMediaSettings, "healthy", capabilities);
  const down = mediaRoutes(defaultMediaSettings, "restarting", capabilities);
  expect(changedRoutes(up, down)).toEqual(["tab", "screen"]);
  expect(down.tab.producer).toBe("none");
  expect(
    changedRoutes(down, mediaRoutes(defaultMediaSettings, "unavailable", capabilities)),
  ).toEqual([]);
});
