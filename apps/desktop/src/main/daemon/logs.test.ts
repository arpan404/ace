import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { logFolders } from "./logs.ts";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "ace-logs-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A daemon home and the app's logs folder (where `desktop.jsonl` is written). */
function folders() {
  const base = root();
  const desktop = join(base, "Library", "Logs", "ace");
  mkdirSync(desktop, { recursive: true });
  return { daemonHome: join(base, ".ace"), desktop };
}

describe("Show Logs", () => {
  it("opens the daemon's log folder and the app's own log folder", () => {
    const { daemonHome, desktop } = folders();
    mkdirSync(join(daemonHome, "logs"), { recursive: true });
    const managed = { kind: "managed", home: daemonHome, entry: "/x", isolated: false } as const;
    expect(logFolders(managed, desktop, existsSync)).toEqual([join(daemonHome, "logs"), desktop]);
    expect(
      logFolders({ kind: "attach", home: daemonHome, isolated: false }, desktop, existsSync),
    ).toEqual([join(daemonHome, "logs"), desktop]);
  });

  it("falls back to the daemon home before the daemon has written logs", () => {
    const { daemonHome, desktop } = folders();
    const target = { kind: "managed", home: daemonHome, entry: "/x", isolated: false } as const;
    expect(logFolders(target, desktop, existsSync)).toEqual([desktop]);
    mkdirSync(daemonHome, { recursive: true });
    expect(logFolders(target, desktop, existsSync)).toEqual([daemonHome, desktop]);
  });

  it("still shows the app's log for a daemon on another machine", () => {
    const { desktop } = folders();
    expect(
      logFolders(
        { kind: "remote", url: "wss://example.com", token: "0".repeat(64) },
        desktop,
        existsSync,
      ),
    ).toEqual([desktop]);
    expect(logFolders({ kind: "remote-only", reason: "x" }, desktop, existsSync)).toEqual([
      desktop,
    ]);
  });

  it("has nothing to show before any log folder exists", () => {
    const base = root();
    const target = {
      kind: "managed",
      home: join(base, ".ace"),
      entry: "/x",
      isolated: false,
    } as const;
    expect(logFolders(target, join(base, "Logs"), existsSync)).toEqual([]);
  });

  it("opens a shared folder once", () => {
    const { daemonHome } = folders();
    mkdirSync(join(daemonHome, "logs"), { recursive: true });
    const target = { kind: "managed", home: daemonHome, entry: "/x", isolated: false } as const;
    expect(logFolders(target, join(daemonHome, "logs"), existsSync)).toEqual([
      join(daemonHome, "logs"),
    ]);
  });
});
