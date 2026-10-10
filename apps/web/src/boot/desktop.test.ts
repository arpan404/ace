import { describe, expect, it } from "vitest";
import {
  desktopAppVersion,
  desktopConnection,
  desktopDaemon,
  hasDesktopBridge,
} from "./desktop.ts";

const token = "ab".repeat(32);

describe("desktop daemon hand-off", () => {
  it("uses only the installed app version supplied by preload", () => {
    expect(desktopAppVersion({ ace: { version: " 1.2.3 " } })).toBe("1.2.3");
    expect(desktopAppVersion({ ace: { version: 42 } })).toBeUndefined();
    expect(desktopAppVersion({ ace: { version: " " } })).toBeUndefined();
    expect(desktopAppVersion({})).toBeUndefined();
  });

  it("a browser in fake mode isn't the desktop app, though it exposes a debugging `ace`", () => {
    const fakeDebug = { ace: { daemon: { token: "x", threads: new Map() }, client: {} } };
    expect(hasDesktopBridge(fakeDebug)).toBe(false);
    expect(
      hasDesktopBridge({ ace: { platform: "darwin", daemon: { connection: async () => ({}) } } }),
    ).toBe(true);
  });

  it("connects to the daemon the desktop bridge hands over", async () => {
    const scope = {
      ace: {
        platform: "darwin",
        daemon: {
          connection: async () => ({ mode: "daemon", url: "ws://127.0.0.1:4242/", token }),
        },
      },
    };
    await expect(desktopConnection(scope)).resolves.toEqual({
      kind: "target",
      target: { url: "ws://127.0.0.1:4242/", token },
    });
  });

  it("falls back to the browser flow without a bridge or in the desktop's fake mode", async () => {
    await expect(desktopConnection({})).resolves.toEqual({ kind: "none" });
    await expect(
      desktopConnection({
        ace: { platform: "darwin", daemon: { connection: async () => ({ mode: "fake" }) } },
      }),
    ).resolves.toEqual({ kind: "none" });
  });

  it("reports a daemon that failed to start with the reason, without Electron's prefix", async () => {
    const scope = {
      ace: {
        platform: "darwin",
        daemon: {
          connection: () =>
            Promise.reject(
              new Error(
                "Error invoking remote method 'ace:daemon.connection': Error: Legacy ace data in ~/.ace",
              ),
            ),
          status: async () => ({ state: "failed", source: "app", restarts: 3, paused: false }),
        },
      },
    };
    await expect(desktopConnection(scope)).resolves.toEqual({
      kind: "failed",
      reason: "Legacy ace data in ~/.ace",
      remoteOnly: false,
    });
  });

  it("knows when this computer runs no daemon and the person must connect to one elsewhere", async () => {
    const scope = {
      ace: {
        platform: "darwin",
        daemon: {
          connection: () => Promise.reject(new Error("No local daemon on Windows")),
          status: async () => ({ state: "unavailable", source: "remote", restarts: 0 }),
        },
      },
    };
    await expect(desktopConnection(scope)).resolves.toMatchObject({
      kind: "failed",
      remoteOnly: true,
    });
  });

  it("reads diagnostics checks and drops malformed ones", async () => {
    const daemon = desktopDaemon({
      ace: {
        platform: "darwin",
        daemon: {
          connection: () => new Promise(() => {}),
          diagnose: async () => ({
            at: 1,
            checks: [
              { id: "node", status: "ok", message: "Node 24.1", fix: "" },
              { id: 42, message: "broken" },
            ],
          }),
        },
      },
    });
    await expect(daemon?.diagnose()).resolves.toEqual([
      { id: "node", status: "ok", message: "Node 24.1", fix: "" },
    ]);
  });
});
