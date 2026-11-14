import { describe, expect, it } from "vitest";
import {
  builtRouteCapabilities,
  changedRoutes,
  mediaRoutes,
  sourceKinds,
  type RouteCapabilities,
  type SourceRoute,
} from "./routes.ts";
import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";

const values = ["legacy", "auto"] as const;
const settingsTable: MediaSettings[] = values.flatMap((encode) =>
  values.flatMap((delivery) =>
    values.flatMap((recordings) =>
      values.map((stills) => ({ encode, delivery, recordings, stills })),
    ),
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
  ["all absent", builtRouteCapabilities],
  ["no ingest", { ...everything, ingest: [] }],
  ["tab ingest only", { ...everything, ingest: ["tab"] }],
  ["no recorder", { ...everything, recordings: false }],
  ["no stills", { ...everything, stills: false }],
  ["no delivery", { ...everything, delivery: false }],
];

const consumers = (route: SourceRoute) => [route.deliverer, route.recorder, route.stills];

describe("every setting combination × health × capabilities is a complete route", () => {
  for (const settings of settingsTable)
    for (const health of healths)
      for (const [capabilityName, capabilities] of capabilityTable)
        it(`${JSON.stringify(settings)}, ${health}, ${capabilityName}`, () => {
          const routes = mediaRoutes(settings, health, capabilities);
          for (const kind of sourceKinds) {
            const route = routes[kind];
            const where = `${kind}: ${JSON.stringify(route)}`;
            // Every consumer has an input: frames in the daemon for a legacy one, in ace-media
            // for ace-media's.
            for (const consumer of consumers(route)) {
              const inDaemon = route.producer === "daemon" || route.egress;
              const inMedia = route.producer === "ace-media" || route.tee;
              expect(consumer === "legacy" ? inDaemon : inMedia, where).toBe(true);
            }
            // Tee and egress exactly when the table says, never both.
            expect(route.tee, where).toBe(
              route.producer === "daemon" && consumers(route).includes("ace-media"),
            );
            expect(route.egress, where).toBe(
              route.producer === "ace-media" && consumers(route).includes("legacy"),
            );
            expect(route.tee && route.egress, where).toBe(false);
            // Nothing runs in ace-media unless it is healthy and asked for.
            if (health !== "healthy") {
              expect(route.producer, where).toBe("daemon");
              expect(consumers(route), where).toEqual(["legacy", "legacy", "legacy"]);
            }
            // ace-media takes a part only when its setting is auto and the build can do it.
            const asked = {
              deliverer: settings.delivery === "auto" && capabilities.delivery,
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
        });
});

function healthy(settings: MediaSettings, capabilities = everything): SourceRoute {
  return mediaRoutes(settings, "healthy", capabilities).screen;
}

describe("named routes", () => {
  it("everything legacy is today's direct route", () => {
    expect(
      healthy({ encode: "legacy", delivery: "legacy", recordings: "legacy", stills: "legacy" }),
    ).toEqual({
      producer: "daemon",
      tee: false,
      egress: false,
      deliverer: "legacy",
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

  it("encode alone on auto sends every unit back through egress to the legacy consumers", () => {
    expect(
      healthy({ encode: "auto", delivery: "legacy", recordings: "legacy", stills: "legacy" }),
    ).toMatchObject({ producer: "ace-media", egress: true, deliverer: "legacy" });
  });

  it("encode legacy with recordings auto tees into ace-media", () => {
    expect(
      healthy({ encode: "legacy", delivery: "legacy", recordings: "auto", stills: "legacy" }),
    ).toMatchObject({ producer: "daemon", tee: true, egress: false, recorder: "ace-media" });
  });

  it("everything auto needs neither tee nor egress", () => {
    expect(
      healthy({ encode: "auto", delivery: "auto", recordings: "auto", stills: "auto" }),
    ).toMatchObject({ producer: "ace-media", tee: false, egress: false });
  });

  it("a kind whose producer can't stream into ace-media stays on the daemon, teeing for ace-media's consumers", () => {
    const settings: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "legacy",
      stills: "legacy",
    };
    const routes = mediaRoutes(settings, "healthy", { ...everything, ingest: ["tab"] });
    expect(routes.tab).toMatchObject({ producer: "ace-media", egress: true });
    expect(routes.simulator).toMatchObject({ producer: "daemon", tee: true, egress: false });
  });

  it("today's build routes nothing through ace-media whatever the settings", () => {
    const auto: MediaSettings = {
      encode: "auto",
      delivery: "auto",
      recordings: "auto",
      stills: "auto",
    };
    for (const kind of sourceKinds)
      expect(mediaRoutes(auto, "healthy", builtRouteCapabilities)[kind]).toMatchObject({
        producer: "daemon",
        tee: false,
        egress: false,
      });
  });
});

it("ace-media going away changes exactly the kinds that were routed through it", () => {
  const settings: MediaSettings = {
    encode: "auto",
    delivery: "legacy",
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
