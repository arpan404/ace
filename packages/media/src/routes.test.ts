import { describe, expect, it } from "vitest";
import {
  builtRouteCapabilities,
  platformRouteCapabilities,
  changedRoutes,
  mediaRoutes,
  sourceKinds,
  type RouteCapabilities,
  type SourceRoute,
} from "./routes.ts";
import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";

const values = ["legacy", "auto"] as const;
const settingsTable: MediaSettings[] = values.flatMap((delivery) =>
  values.flatMap((recordings) =>
    values.map((stills) => ({ encode: "auto" as const, delivery, recordings, stills })),
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

const consumers = (route: SourceRoute) => [route.deliverer, route.recorder, route.stills];
const auto: MediaSettings = {
  encode: "auto",
  delivery: "auto",
  recordings: "auto",
  stills: "auto",
};

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
            // Every legacy consumer of a streaming source is fed back through egress.
            if (route.producer === "ace-media")
              expect(route.egress, where).toBe(consumers(route).includes("legacy"));
            else expect(route.egress, where).toBe(false);
            // Nothing runs in ace-media unless it is healthy and asked for.
            if (health !== "healthy")
              expect(consumers(route), where).toEqual(["legacy", "legacy", "legacy"]);
            const asked = {
              deliverer: settings.delivery === "auto" && capabilities.delivery,
              recorder: settings.recordings === "auto" && capabilities.recordings,
              stills: settings.stills === "auto" && capabilities.stills,
            };
            for (const part of ["deliverer", "recorder", "stills"] as const)
              if (route[part] === "ace-media") expect(asked[part], where).toBe(true);
          }
        }
    });
});

describe("named routes", () => {
  it("delivery, recordings and stills on legacy are all fed through egress", () => {
    expect(
      mediaRoutes(
        { ...auto, delivery: "legacy", recordings: "legacy", stills: "legacy" },
        "healthy",
        everything,
      ).screen,
    ).toEqual({
      producer: "ace-media",
      egress: true,
      deliverer: "legacy",
      recorder: "legacy",
      stills: "legacy",
    });
  });

  it("delivery on auto with recordings and stills legacy feeds the daemon's recorder and still maker through egress", () => {
    expect(
      mediaRoutes({ ...auto, recordings: "legacy", stills: "legacy" }, "healthy", everything).tab,
    ).toEqual({
      producer: "ace-media",
      egress: true,
      deliverer: "ace-media",
      recorder: "legacy",
      stills: "legacy",
    });
  });

  it("everything auto needs no egress", () => {
    expect(mediaRoutes(auto, "healthy", everything).tab).toMatchObject({
      producer: "ace-media",
      egress: false,
    });
  });

  it("a kind ace-media can't take streams nowhere, never to the daemon", () => {
    const routes = mediaRoutes(auto, "healthy", { ...everything, ingest: ["tab"] });
    expect(routes.tab.producer).toBe("ace-media");
    expect(routes.simulator).toMatchObject({ producer: "none", egress: false });
  });

  it("every platform streams its browsers, screen and Android devices into ace-media; a Mac its Simulators and host-encoded emulators too", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const routes = mediaRoutes(auto, "healthy", platformRouteCapabilities(platform));
      for (const kind of [
        "tab",
        "tab-pictures",
        "user-tab",
        "embedded",
        "screen",
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
  const settings: MediaSettings = {
    ...auto,
    delivery: "legacy",
    recordings: "legacy",
    stills: "legacy",
  };
  const capabilities = { ...builtRouteCapabilities, ingest: ["tab", "screen"] as const };
  const up = mediaRoutes(settings, "healthy", capabilities);
  const down = mediaRoutes(settings, "restarting", capabilities);
  expect(changedRoutes(up, down)).toEqual(["tab", "screen"]);
  expect(down.tab.producer).toBe("none");
  expect(changedRoutes(down, mediaRoutes(settings, "unavailable", capabilities))).toEqual([]);
});
