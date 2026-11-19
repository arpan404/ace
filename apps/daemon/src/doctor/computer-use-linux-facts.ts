import { execFile } from "node:child_process";
import { graphicalSessionEnvironment } from "@ace/screen";
import { computerUsePorts } from "./computer-use-facts.ts";
import {
  busctlBool,
  busctlNames,
  busctlUint,
  type LinuxComputerFacts,
  type LinuxComputerPorts,
} from "./computer-use-linux.ts";

/** Runs `busctl --user` on the session bus `env` names; resolves stdout, undefined on failure. */
export type Busctl = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<string | undefined>;

const busctl: Busctl = (args, env) =>
  new Promise((resolve) => {
    execFile(
      "busctl",
      ["--user", ...args],
      { env, timeout: 3000, maxBuffer: 256 * 1024, encoding: "utf8" },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });

const PORTAL = ["org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop"] as const;
const DBUS = ["org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus"] as const;

/**
 * Reads the facts with read-only bus calls. A name counts as there when something owns it or
 * the bus can start it (the accessibility bus and notification servers start on first use).
 */
export async function readLinuxComputerFacts(
  env: NodeJS.ProcessEnv,
  run: Busctl = busctl,
): Promise<LinuxComputerFacts> {
  const session = await graphicalSessionEnvironment({ env })();
  const desktop = session.XDG_CURRENT_DESKTOP || undefined;
  if (!session.WAYLAND_DISPLAY)
    return { session: session.DISPLAY ? "x11" : "none", ...(desktop ? { desktop } : {}) };
  const activatable = run(["call", ...DBUS, "ListActivatableNames"], session).then((out) =>
    out === undefined ? undefined : busctlNames(out),
  );
  const present = async (name: string): Promise<boolean | undefined> => {
    const owned = await run(["call", ...DBUS, "NameHasOwner", "s", name], session);
    const has = owned === undefined ? undefined : busctlBool(owned);
    if (has) return true;
    const names = await activatable;
    if (has === undefined && names === undefined) return undefined;
    return names?.includes(name) ?? false;
  };
  const property = async (iface: string, name: string) => {
    const out = await run(["get-property", ...PORTAL, iface, name], session);
    return out === undefined ? undefined : busctlUint(out);
  };
  const [accessibility, portal, screenCast, devices, notifications] = await Promise.all([
    present("org.a11y.Bus"),
    present(PORTAL[0]),
    property("org.freedesktop.portal.ScreenCast", "AvailableSourceTypes"),
    property("org.freedesktop.portal.RemoteDesktop", "AvailableDeviceTypes"),
    present("org.freedesktop.Notifications"),
  ]);
  // With the portal there, an unreadable property means it lacks that interface: none of it.
  const offered = (value: number | undefined) => value ?? (portal === undefined ? undefined : 0);
  const sharing = offered(screenCast);
  const keyboard = offered(devices);
  return {
    session: "wayland",
    ...(desktop ? { desktop } : {}),
    ...(accessibility === undefined ? {} : { accessibility }),
    ...(sharing === undefined ? {} : { screenCast: sharing }),
    ...(keyboard === undefined ? {} : { keyboard: (keyboard & 1) === 1 }),
    ...(notifications === undefined ? {} : { notifications }),
  };
}

export const linuxComputerPorts: LinuxComputerPorts = {
  facts: (context) => readLinuxComputerFacts(context.env),
  screen: computerUsePorts.screen,
};
