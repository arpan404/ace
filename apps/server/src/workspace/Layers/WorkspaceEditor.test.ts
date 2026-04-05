import { existsSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { WorkspaceEditor } from "../Services/WorkspaceEditor.ts";
import { WorkspaceEditorLive } from "./WorkspaceEditor.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const COMMON_NVIM_PATHS = [
  "/opt/homebrew/bin/nvim",
  "/usr/local/bin/nvim",
  "/usr/bin/nvim",
  "/bin/nvim",
] as const;

const hasNvim =
  (typeof process.env.NVIM === "string" && process.env.NVIM.trim().length > 0) ||
  COMMON_NVIM_PATHS.some((candidate) => existsSync(candidate)) ||
  (typeof Bun !== "undefined" && Bun.which("nvim") !== null);

const TEST_NVIM_INIT_LUA = String.raw`
local ns = vim.api.nvim_create_namespace("t3code-workspace-editor-test")

vim.api.nvim_create_autocmd({ "BufReadPost", "TextChanged", "InsertLeave" }, {
  callback = function(args)
    local diagnostics = {}
    local lines = vim.api.nvim_buf_get_lines(args.buf, 0, -1, false)

    for line_index, line in ipairs(lines) do
      local start_col = line:find("ERROR", 1, true)
      if start_col ~= nil then
        diagnostics[#diagnostics + 1] = {
          lnum = line_index - 1,
          col = start_col - 1,
          end_lnum = line_index - 1,
          end_col = start_col - 1 + 5,
          severity = vim.diagnostic.severity.ERROR,
          source = "t3code-test",
          message = "Found ERROR marker",
          code = "TEST001",
        }
      end
    end

    vim.diagnostic.set(ns, args.buf, diagnostics)
  end,
})
`;

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceEditorLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(NodeServices.layer),
);

const withXdgConfigHome = <A, E, R>(configHome: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previousConfigHome = process.env.XDG_CONFIG_HOME;
      const previousAppName = process.env.NVIM_APPNAME;

      process.env.XDG_CONFIG_HOME = configHome;
      delete process.env.NVIM_APPNAME;

      return {
        previousAppName,
        previousConfigHome,
      };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous.previousConfigHome === undefined) {
          delete process.env.XDG_CONFIG_HOME;
        } else {
          process.env.XDG_CONFIG_HOME = previous.previousConfigHome;
        }

        if (previous.previousAppName === undefined) {
          delete process.env.NVIM_APPNAME;
        } else {
          process.env.NVIM_APPNAME = previous.previousAppName;
        }
      }),
  );

describe.skipIf(!hasNvim)("WorkspaceEditorLive", () => {
  it.effect("syncs buffers through headless Neovim IPC and returns diagnostics", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceEditor = yield* WorkspaceEditor;
      const workspaceDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-workspace-editor-",
      });
      const configHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-workspace-editor-config-",
      });
      const nvimConfigDir = path.join(configHome, "nvim");

      yield* fileSystem.makeDirectory(nvimConfigDir, { recursive: true });
      yield* fileSystem.writeFileString(path.join(nvimConfigDir, "init.lua"), TEST_NVIM_INIT_LUA);

      const result = yield* withXdgConfigHome(
        configHome,
        Effect.gen(function* () {
          const clean = yield* workspaceEditor.syncBuffer({
            cwd: workspaceDir,
            relativePath: "src/example.ts",
            contents: "const ready = true;\n",
          });
          const broken = yield* workspaceEditor.syncBuffer({
            cwd: workspaceDir,
            relativePath: "src/example.ts",
            contents: "const ready = true;\nERROR();\n",
          });
          const closed = yield* workspaceEditor.closeBuffer({
            cwd: workspaceDir,
            relativePath: "src/example.ts",
          });

          return {
            broken,
            clean,
            closed,
          };
        }),
      );

      expect(result.clean).toEqual({
        diagnostics: [],
        relativePath: "src/example.ts",
      });
      expect(result.broken).toEqual({
        diagnostics: [
          {
            code: "TEST001",
            endColumn: 5,
            endLine: 1,
            message: "Found ERROR marker",
            severity: "error",
            source: "t3code-test",
            startColumn: 0,
            startLine: 1,
          },
        ],
        relativePath: "src/example.ts",
      });
      expect(result.closed).toEqual({
        relativePath: "src/example.ts",
      });
    }).pipe(Effect.provide(TestLayer)),
  );
});
