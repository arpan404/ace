import { describe, expect, it } from "vitest";
import {
  runMobileHostDiagnostics,
  type MobileHostDiagnosticsTarget,
} from "./mobileHostDiagnostics";

function createTarget(overrides?: {
  readonly failAt?:
    | "config"
    | "snapshot"
    | "tree"
    | "workspace-write"
    | "git"
    | "terminal"
    | "settings"
    | "tooling";
  readonly projects?: ReadonlyArray<{
    readonly id?: string;
    readonly workspaceRoot?: string | null;
  }>;
  readonly threads?: ReadonlyArray<{ readonly id?: string }>;
}): MobileHostDiagnosticsTarget {
  let diagnosticFileContents = "";
  let diagnosticFilePath = "";
  return {
    hostId: "host-1",
    hostName: "Primary host",
    client: {
      server: {
        getConfig: async () => {
          if (overrides?.failAt === "config") {
            throw new Error("config unavailable");
          }
          return { providers: [{ provider: "codex" }, { provider: "claudeAgent" }] };
        },
        getSettings: async () => {
          if (overrides?.failAt === "settings") {
            throw new Error("settings unavailable");
          }
          return {};
        },
        getLspToolsStatus: async () => {
          if (overrides?.failAt === "tooling") {
            throw new Error("tooling unavailable");
          }
          return {};
        },
      },
      orchestration: {
        getSnapshot: async () => {
          if (overrides?.failAt === "snapshot") {
            throw new Error("snapshot unavailable");
          }
          return {
            projects: overrides?.projects ?? [{ id: "project-1", workspaceRoot: "/repo" }],
            threads: overrides?.threads ?? [{ id: "thread-1" }, { id: "thread-2" }],
          };
        },
      },
      projects: {
        listTree: async () => {
          if (overrides?.failAt === "tree") {
            throw new Error("tree unavailable");
          }
          return {
            entries: [{ path: "package.json" }, { path: "src" }, { path: "README.md" }],
            truncated: false,
          };
        },
        createEntry: async (input) => {
          if (overrides?.failAt === "workspace-write") {
            throw new Error("workspace unavailable");
          }
          expect(input.cwd).toBe("/repo");
          expect(input.relativePath).toMatch(/^\.ace-mobile-diagnostics-.+\.txt$/u);
          expect(input.kind).toBe("file");
          diagnosticFilePath = input.relativePath;
          return {};
        },
        writeFile: async (input) => {
          diagnosticFileContents = input.contents;
          expect(input).toMatchObject({
            cwd: "/repo",
            relativePath: diagnosticFilePath,
          });
          return {};
        },
        readFile: async (input) => {
          expect(input).toEqual({
            cwd: "/repo",
            relativePath: diagnosticFilePath,
          });
          return { contents: diagnosticFileContents };
        },
        deleteEntry: async (input) => {
          expect(input).toEqual({
            cwd: "/repo",
            relativePath: diagnosticFilePath,
          });
          return {};
        },
      },
      git: {
        status: async (input) => {
          if (overrides?.failAt === "git") {
            throw new Error("git unavailable");
          }
          expect(input).toEqual({ cwd: "/repo" });
          return {};
        },
      },
      terminal: {
        open: async (input) => {
          if (overrides?.failAt === "terminal") {
            throw new Error("terminal unavailable");
          }
          expect(input).toEqual({
            threadId: "thread-1",
            cwd: "/repo",
            cols: 80,
            rows: 24,
            terminalId: "mobile-diagnostics",
          });
          return {};
        },
        resize: async (input) => {
          expect(input).toEqual({
            threadId: "thread-1",
            cols: 100,
            rows: 30,
            terminalId: "mobile-diagnostics",
          });
          return {};
        },
        close: async (input) => {
          expect(input).toEqual({
            threadId: "thread-1",
            terminalId: "mobile-diagnostics",
            deleteHistory: true,
          });
          return {};
        },
      },
    },
  };
}

describe("runMobileHostDiagnostics", () => {
  it("records successful host smoke checks", async () => {
    await expect(runMobileHostDiagnostics(createTarget())).resolves.toEqual({
      hostId: "host-1",
      hostName: "Primary host",
      checks: [
        "2 providers",
        "1 projects",
        "2 threads",
        "3 files",
        "workspace write",
        "git status",
        "terminal",
        "settings",
        "tooling",
      ],
      error: null,
    });
  });

  it("returns partial checks and the failing RPC error", async () => {
    await expect(runMobileHostDiagnostics(createTarget({ failAt: "settings" }))).resolves.toEqual({
      hostId: "host-1",
      hostName: "Primary host",
      checks: [
        "2 providers",
        "1 projects",
        "2 threads",
        "3 files",
        "workspace write",
        "git status",
        "terminal",
      ],
      error: "settings unavailable",
    });
  });

  it("marks the project workspace check as skipped when no workspace root is available", async () => {
    await expect(runMobileHostDiagnostics(createTarget({ projects: [] }))).resolves.toEqual({
      hostId: "host-1",
      hostName: "Primary host",
      checks: [
        "2 providers",
        "0 projects",
        "2 threads",
        "no project workspace",
        "settings",
        "tooling",
      ],
      error: null,
    });
  });

  it("reports workspace mutation failures after read-only checks", async () => {
    await expect(
      runMobileHostDiagnostics(createTarget({ failAt: "workspace-write" })),
    ).resolves.toEqual({
      hostId: "host-1",
      hostName: "Primary host",
      checks: ["2 providers", "1 projects", "2 threads", "3 files"],
      error: "workspace unavailable",
    });
  });

  it("skips terminal checks when the host has no thread context", async () => {
    await expect(runMobileHostDiagnostics(createTarget({ threads: [] }))).resolves.toEqual({
      hostId: "host-1",
      hostName: "Primary host",
      checks: [
        "2 providers",
        "1 projects",
        "0 threads",
        "3 files",
        "workspace write",
        "git status",
        "no terminal thread",
        "settings",
        "tooling",
      ],
      error: null,
    });
  });
});
