import { afterEach, expect, it } from "vitest";
import type { CheckResult } from "@ace/diagnostics";
import type { ScreenFacts } from "./computer-use-facts.ts";
import { readLinuxComputerFacts, type Busctl } from "./computer-use-linux-facts.ts";
import { computerUseFeature } from "./computer-use.ts";
import { computerUsePorts } from "./computer-use-facts.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const signal = new AbortController().signal;
const wayland = {
  HOME: "/home/p",
  PATH: "",
  WAYLAND_DISPLAY: "wayland-0",
  XDG_CURRENT_DESKTOP: "GNOME",
};

/** A session bus as `busctl --user` answers it: names owned, names the bus can start, properties. */
function bus(desktop: {
  owned?: string[];
  activatable?: string[];
  properties?: Record<string, string>;
}): Busctl {
  return async (args) => {
    const [verb, , , , member, , name] = args;
    if (verb === "call" && member === "NameHasOwner")
      return `b ${(desktop.owned ?? []).includes(name ?? "")}\n`;
    if (verb === "call" && member === "ListActivatableNames") {
      const names = desktop.activatable ?? [];
      return `as ${names.length} ${names.map((n) => `"${n}"`).join(" ")}\n`;
    }
    if (verb === "get-property") return desktop.properties?.[`${args[3]}.${args[4]}`];
    return undefined;
  };
}

async function verdicts(env: NodeJS.ProcessEnv, run: Busctl, screen?: ScreenFacts) {
  const { context, cleanup } = await doctorTestContext({ platform: "linux", env });
  cleanups.push(cleanup);
  const feature = computerUseFeature(computerUsePorts, {
    facts: () => readLinuxComputerFacts(env, run),
    screen: async () => screen,
  });
  const results = new Map<string, Omit<CheckResult, "id">>();
  for (const check of feature.checks(context)) results.set(check.id, await check.run(signal));
  return results;
}

const gnome = bus({
  owned: ["org.freedesktop.portal.Desktop", "org.freedesktop.Notifications"],
  activatable: ["org.a11y.Bus"],
  properties: {
    "org.freedesktop.portal.ScreenCast.AvailableSourceTypes": "u 3\n",
    "org.freedesktop.portal.RemoteDesktop.AvailableDeviceTypes": "u 7\n",
  },
});

it("a GNOME Wayland session with everything computer use needs passes every check", async () => {
  const results = await verdicts(wayland, gnome, {
    kind: "known",
    enabled: true,
    permissions: { accessibility: true, screenRecording: true },
  });
  expect([...results.values()].map((r) => r.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
  expect(results.get("computer.session")?.message).toBe("Wayland session (GNOME)");
  expect(results.get("computer.screenshots")?.message).toContain("windows");
  expect(results.get("computer.typing")?.message).toContain("Typing in front");
});

it("an X11 session warns how to switch, and nothing on its bus is judged", async () => {
  const results = await verdicts({ HOME: "/home/p", PATH: "", DISPLAY: ":0" }, gnome);
  expect(results.get("computer.session")).toMatchObject({ status: "warn" });
  expect(results.get("computer.session")?.message).toContain("X11");
  expect(results.get("computer.session")?.fix).toContain("Wayland");
  for (const id of ["computer.accessibility", "computer.screenshots", "computer.notifications"])
    expect(results.get(id)?.message).toBe("Not checked: no Wayland session");
});

it("a desktop without a notification server warns that the Stop notice can't show", async () => {
  const results = await verdicts(
    { ...wayland, XDG_CURRENT_DESKTOP: "Hyprland" },
    bus({
      owned: ["org.freedesktop.portal.Desktop"],
      activatable: ["org.a11y.Bus"],
      properties: { "org.freedesktop.portal.ScreenCast.AvailableSourceTypes": "u 3\n" },
    }),
  );
  expect(results.get("computer.notifications")).toMatchObject({ status: "warn" });
  expect(results.get("computer.notifications")?.fix).toContain("mako");
  // Hyprland's portal has no RemoteDesktop: said plainly, but nothing to fix.
  expect(results.get("computer.typing")).toMatchObject({ status: "ok" });
  expect(results.get("computer.typing")?.message).toContain("can't type into Chromium");
});

it("missing accessibility and screen sharing warn with the package to install", async () => {
  const results = await verdicts(wayland, bus({ owned: ["org.freedesktop.Notifications"] }));
  expect(results.get("computer.accessibility")).toMatchObject({ status: "warn" });
  expect(results.get("computer.accessibility")?.fix).toContain("at-spi2-core");
  expect(results.get("computer.screenshots")).toMatchObject({ status: "warn" });
  expect(results.get("computer.screenshots")?.fix).toContain("xdg-desktop-portal");
});

it("a session bus that doesn't answer leaves the facts unknown and never warns", async () => {
  const results = await verdicts(wayland, async () => undefined);
  for (const id of [
    "computer.accessibility",
    "computer.screenshots",
    "computer.typing",
    "computer.notifications",
  ]) {
    expect(results.get(id)?.status).toBe("ok");
    expect(results.get(id)?.message).toContain("unknown");
  }
});

it("ace running without its screen helper warns", async () => {
  const results = await verdicts(wayland, gnome, { kind: "unconfigured" });
  expect(results.get("computer.helper")).toMatchObject({
    status: "warn",
    message: "ace is running without its screen helper, so computer use is unavailable",
  });
});
