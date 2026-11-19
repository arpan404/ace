import { describe, expect, it } from "vitest";
import { DaemonSupervisor } from "../daemon/supervisor.ts";
import { machine } from "../daemon/supervisor-test-support.ts";
import { QuitGate } from "./quit-gate.ts";

/**
 * The app as far as quitting goes: a supervisor that started its own daemon, and a gate whose
 * quit records whether that daemon was still alive when the app exited.
 */
async function app(options: { boundMs?: number; shutDown?: () => Promise<void> } = {}) {
  const m = machine();
  const supervisor = new DaemonSupervisor(m.ports, { stopGraceMs: 10_000 });
  void supervisor.start();
  await m.advance(0);
  m.state.answering = true;
  await m.advance(1_000);
  const daemon = m.children[0];
  const exits: { daemonAlive: boolean }[] = [];
  const gate = new QuitGate({
    shutDown: options.shutDown ?? (() => supervisor.stop()),
    quit: () => exits.push({ daemonAlive: daemon?.alive ?? false }),
    timers: m.ports.timers,
    log: m.ports.log,
    ...(options.boundMs ? { boundMs: options.boundMs } : {}),
  });
  /** Electron's `before-quit`: whether it let the quit go ahead. */
  const quit = () => gate.request();
  return { m, gate, daemon, exits, quit, supervisor };
}

describe("quitting the app", () => {
  it("quitting waits for the daemon to exit before the app exits", async () => {
    const { m, daemon, exits, quit } = await app();
    expect(daemon?.alive).toBe(true);
    // The daemon finishes a long step before its shutdown completes.
    m.state.sigtermExitMs = 4_000;

    expect(quit()).toBe(false);
    await m.advance(3_000);
    expect(exits).toEqual([]);
    await m.advance(2_000);

    expect(exits).toEqual([{ daemonAlive: false }]);
    // The real quit that follows goes ahead.
    expect(quit()).toBe(true);
  });

  it("a second quit while the daemon stops still waits for it", async () => {
    const { m, exits, quit } = await app();
    m.state.sigtermExitMs = 4_000;

    expect(quit()).toBe(false);
    await m.advance(1_000);
    // Cmd+Q again, the tray's Quit, the last window closing.
    expect(quit()).toBe(false);
    expect(quit()).toBe(false);
    await m.advance(1_000);
    expect(exits).toEqual([]);

    await m.advance(5_000);
    expect(exits).toEqual([{ daemonAlive: false }]);
  });

  it("a daemon that ignores SIGTERM is killed before the app exits", async () => {
    const { m, exits, quit } = await app();
    m.state.ignoresSigterm = true;

    quit();
    await m.advance(9_000);
    expect(exits).toEqual([]);
    await m.advance(2_000);

    expect(exits).toEqual([{ daemonAlive: false }]);
    expect(m.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("quits anyway once shutdown runs past the bound, so a quit never hangs", async () => {
    const { m, exits, quit } = await app({
      boundMs: 30_000,
      shutDown: () => new Promise<void>(() => {}),
    });

    expect(quit()).toBe(false);
    await m.advance(29_000);
    expect(exits).toHaveLength(0);
    await m.advance(1_000);

    expect(exits).toHaveLength(1);
    expect(m.log.some((entry) => entry.message.includes("quitting anyway"))).toBe(true);
    expect(quit()).toBe(true);
  });

  it("a shutdown that fails still lets the app quit", async () => {
    const { m, exits, quit } = await app({
      shutDown: () => Promise.reject(new Error("browser backend gone")),
    });

    quit();
    await m.advance(0);

    expect(exits).toHaveLength(1);
    expect(m.log.some((entry) => String(entry.data?.error).includes("browser backend gone"))).toBe(
      true,
    );
  });

  it("an update's restart stops the daemon once, then lets the installer's quit through", async () => {
    const { m, gate, daemon, exits, quit } = await app();
    m.state.sigtermExitMs = 2_000;

    const prepared = gate.shutDown();
    // A quit asked while the update prepares shares the same shutdown.
    expect(quit()).toBe(false);
    await m.advance(3_000);
    await prepared;

    expect(daemon?.alive).toBe(false);
    expect(m.signals).toEqual(["SIGTERM"]);
    // The installer's own quit goes ahead.
    expect(quit()).toBe(true);
    expect(exits).toEqual([{ daemonAlive: false }]);
  });
});
