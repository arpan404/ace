import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonLogsPath } from "./logs.ts";

const roots: string[] = [];
function home(): string {
  const root = mkdtempSync(join(tmpdir(), "ace-logs-"));
  roots.push(root);
  return join(root, ".ace");
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Show Logs", () => {
  it("opens the daemon's log folder once it has written logs", () => {
    const daemonHome = home();
    mkdirSync(join(daemonHome, "logs"), { recursive: true });
    const managed = { kind: "managed", home: daemonHome, entry: "/x", isolated: false } as const;
    expect(daemonLogsPath(managed, existsSync)).toBe(join(daemonHome, "logs"));
    expect(daemonLogsPath({ kind: "attach", home: daemonHome, isolated: false }, existsSync)).toBe(
      join(daemonHome, "logs"),
    );
  });

  it("falls back to the daemon home before any log exists, and to nothing without one", () => {
    const daemonHome = home();
    const target = { kind: "managed", home: daemonHome, entry: "/x", isolated: false } as const;
    expect(daemonLogsPath(target, existsSync)).toBeUndefined();
    mkdirSync(daemonHome, { recursive: true });
    expect(daemonLogsPath(target, existsSync)).toBe(daemonHome);
  });

  it("has nothing to show for a daemon on another machine", () => {
    expect(
      daemonLogsPath(
        { kind: "remote", url: "wss://example.com", token: "0".repeat(64) },
        existsSync,
      ),
    ).toBeUndefined();
    expect(daemonLogsPath({ kind: "remote-only", reason: "x" }, existsSync)).toBeUndefined();
  });
});
