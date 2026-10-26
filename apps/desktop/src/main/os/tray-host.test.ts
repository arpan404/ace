import { describe, expect, it } from "vitest";
import { linuxTrayHost, type RunProgram } from "./tray-host.ts";

/** gdbus as it answers on a real session bus. */
const answers =
  (stdout: string): RunProgram =>
  async () =>
    stdout;
const fails =
  (message: string): RunProgram =>
  async () => {
    throw new Error(message);
  };

describe("linuxTrayHost", () => {
  it("sees a tray where a StatusNotifier host is registered (KDE, GNOME with AppIndicator)", async () => {
    expect(await linuxTrayHost(answers("(<true>,)\n"))).toBe(true);
  });

  it("sees no tray where the watcher has no host", async () => {
    expect(await linuxTrayHost(answers("(<false>,)\n"))).toBe(false);
  });

  it("sees no tray where nothing owns the watcher (stock GNOME, bare window managers)", async () => {
    expect(
      await linuxTrayHost(
        fails(
          "Command failed: gdbus call …\nError: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable",
        ),
      ),
    ).toBe(false);
  });

  it("assumes a tray when the question can't be asked", async () => {
    expect(await linuxTrayHost(fails("spawn gdbus ENOENT"))).toBe(true);
    expect(await linuxTrayHost(fails("Command failed: gdbus call … (killed after timeout)"))).toBe(
      true,
    );
  });
});
