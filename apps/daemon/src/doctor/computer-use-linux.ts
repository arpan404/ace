import type { Check } from "@ace/diagnostics";
import type { ScreenFacts } from "./computer-use-facts.ts";
import type { DoctorContext } from "./feature.ts";

/**
 * What Linux computer use stands on, read without changing anything: the person's desktop
 * session (from the systemd user manager, as the daemon finds it), and on its session bus the
 * accessibility bus, the portal's screen sharing and keyboard, and a notification server for
 * the "ace is using" notice and its Stop. Undefined bus facts were not readable.
 */
export type LinuxComputerFacts = {
  session: "wayland" | "x11" | "none";
  /** XDG_CURRENT_DESKTOP, e.g. "GNOME", "KDE", "Hyprland". */
  desktop?: string;
  accessibility?: boolean;
  /** ScreenCast's AvailableSourceTypes: 1 monitors, 2 windows; 0 when it has no ScreenCast. */
  screenCast?: number;
  /** RemoteDesktop offers a keyboard (AvailableDeviceTypes & 1). */
  keyboard?: boolean;
  notifications?: boolean;
};

export type LinuxComputerPorts = {
  facts(context: DoctorContext): Promise<LinuxComputerFacts>;
  /** The running daemon's screen helper, as on macOS; undefined while ace is stopped. */
  screen(context: DoctorContext): Promise<ScreenFacts | undefined>;
};

const sessionFix =
  "Log in to a Wayland desktop session (on Ubuntu, “Ubuntu”, not “Ubuntu on Xorg”). ace finds it on its own.";

export function linuxComputerChecks(context: DoctorContext, ports: LinuxComputerPorts): Check[] {
  let facts: Promise<LinuxComputerFacts> | undefined;
  const load = () => (facts ??= ports.facts(context));
  const onBus = (
    id: string,
    fix: string,
    verdict: (facts: LinuxComputerFacts) => { status: "ok" | "warn"; message: string },
  ): Check => ({
    id,
    fix,
    async run() {
      const found = await load();
      if (found.session !== "wayland")
        return { status: "ok", message: "Not checked: no Wayland session", fix };
      return { ...verdict(found), fix };
    },
  });
  return [
    {
      id: "computer.session",
      fix: sessionFix,
      async run() {
        const found = await load();
        if (found.session === "wayland")
          return {
            status: "ok",
            message: `Wayland session${found.desktop ? ` (${found.desktop})` : ""}`,
            fix: sessionFix,
          };
        return {
          status: "warn",
          message:
            found.session === "x11"
              ? "The desktop runs an X11 session; computer use and live view need Wayland"
              : "Nobody is logged in to a desktop ace can reach, so computer use is unavailable",
          fix: sessionFix,
        };
      },
    },
    helperCheck(context, ports),
    onBus(
      "computer.accessibility",
      "Install at-spi2-core (it comes with GNOME and KDE), log out and back in.",
      (found) =>
        found.accessibility
          ? { status: "ok", message: "Accessibility bus (AT-SPI) is available" }
          : found.accessibility === false
            ? {
                status: "warn",
                message:
                  "The accessibility bus (AT-SPI) isn't available, so agents can't see or use apps",
              }
            : {
                status: "ok",
                message: "Accessibility bus: unknown (the session bus didn't answer)",
              },
    ),
    onBus(
      "computer.screenshots",
      "Install your desktop's xdg-desktop-portal backend (-gnome, -kde or -hyprland), then log out and back in.",
      (found) =>
        found.screenCast === undefined
          ? { status: "ok", message: "Screen sharing: unknown (the portal didn't answer)" }
          : found.screenCast & 3
            ? {
                status: "ok",
                message: `Screen sharing through the portal (${found.screenCast & 2 ? "windows" : "whole screens"})`,
              }
            : {
                status: "warn",
                message:
                  "The desktop portal offers no screen sharing, so agents get no screenshots",
              },
    ),
    onBus(
      "computer.typing",
      "Nothing to do: this desktop's portal has no remote keyboard (Hyprland's doesn't).",
      (found) =>
        found.keyboard === undefined
          ? { status: "ok", message: "Portal keyboard: unknown (the portal didn't answer)" }
          : found.keyboard
            ? {
                status: "ok",
                message:
                  "Typing in front through the portal's keyboard (Chromium and Electron apps)",
              }
            : {
                status: "ok",
                message:
                  "No portal keyboard here, so agents can't type into Chromium and Electron apps; everything else works",
              },
    ),
    onBus(
      "computer.notifications",
      "Start your desktop's notification server (mako on Hyprland; GNOME and KDE run their own).",
      (found) =>
        found.notifications === undefined
          ? { status: "ok", message: "Notifications: unknown (the session bus didn't answer)" }
          : found.notifications === false
            ? {
                status: "warn",
                message:
                  "No notification server, so the person never sees “ace is using …” or its Stop",
              }
            : { status: "ok", message: "Notifications show “ace is using …” with Stop" },
    ),
  ];
}

function helperCheck(context: DoctorContext, ports: LinuxComputerPorts): Check {
  const fix =
    "Start ace from the desktop app or the release archive, which include the screen helper.";
  return {
    id: "computer.helper",
    fix,
    async run() {
      const facts = await ports.screen(context);
      if (!facts)
        return { status: "ok", message: "Screen helper: unknown while ace is stopped", fix };
      if (facts.kind === "unconfigured")
        return {
          status: "warn",
          message: "ace is running without its screen helper, so computer use is unavailable",
          fix,
        };
      if (facts.kind === "failed")
        return {
          status: "warn",
          message: `The screen helper didn't answer: ${facts.message.slice(0, 512)}`,
          fix: "Turn computer use off and on in Settings › Computer use. If it still fails, run ace triage.",
        };
      return { status: "ok", message: "Screen helper is running", fix };
    },
  };
}

/** `busctl` output for a boolean reply or property: `b true`. */
export function busctlBool(output: string): boolean | undefined {
  const match = /^b (true|false)\s*$/.exec(output.trim());
  return match ? match[1] === "true" : undefined;
}

/** `busctl` output for an unsigned property: `u 3`. */
export function busctlUint(output: string): number | undefined {
  const match = /^u (\d+)\s*$/.exec(output.trim());
  return match ? Number(match[1]) : undefined;
}

/** `busctl` output for a string array: `as 2 "a.b" "c.d"`. */
export function busctlNames(output: string): string[] | undefined {
  if (!/^as \d+/.test(output.trim())) return undefined;
  return [...output.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "");
}
