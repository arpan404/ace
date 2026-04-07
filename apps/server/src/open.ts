/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { extname, join } from "node:path";

import { EDITORS, OpenError, type EditorId } from "@ace/contracts";
import { ServiceMap, Effect, Layer } from "effect";

import { runProcess, type ProcessRunResult } from "./processRunner";

// ==============================
// Definitions
// ==============================

export { OpenError };

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface FolderPickerLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly isCancelled: (result: ProcessRunResult) => boolean;
}

interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

function shouldUseGotoFlag(editor: (typeof EDITORS)[number], target: string): boolean {
  return editor.supportsGoto && LINE_COLUMN_SUFFIX_PATTERN.test(target);
}

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const extension of windowsPathExtensions) {
    candidates.push(`${command}${extension}`);
    candidates.push(`${command}${extension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") {
      const extension = extname(filePath);
      if (extension.length === 0) return false;
      return windowsPathExtensions.includes(extension.toUpperCase());
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function normalizePickedFolderPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/g, "");
  return path.length > 0 ? path : null;
}

function resolveLinuxFolderPickerLaunch(env: NodeJS.ProcessEnv): FolderPickerLaunch | null {
  if (isCommandAvailable("zenity", { platform: "linux", env })) {
    return {
      command: "zenity",
      args: ["--file-selection", "--directory", "--title=Select a project folder"],
      isCancelled: (result) => result.code === 1 && result.stderr.trim().length === 0,
    };
  }

  if (isCommandAvailable("kdialog", { platform: "linux", env })) {
    return {
      command: "kdialog",
      args: ["--getexistingdirectory", ".", "--title", "Select a project folder"],
      isCancelled: (result) => result.code === 1 && result.stderr.trim().length === 0,
    };
  }

  return null;
}

function resolveFolderPickerUnavailableMessage(platform: NodeJS.Platform): string {
  if (platform === "linux") {
    return "Folder picker is unavailable. Install zenity or kdialog, or enter the path manually.";
  }
  return "Folder picker is unavailable on this system. Enter the path manually.";
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  if (command.includes("/") || command.includes("\\")) {
    return commandCandidates.some((candidate) =>
      isExecutableFile(candidate, platform, windowsPathExtensions),
    );
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) return false;
  const pathEntries = pathValue
    .split(resolvePathDelimiter(platform))
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      if (isExecutableFile(join(pathEntry, candidate), platform, windowsPathExtensions)) {
        return true;
      }
    }
  }
  return false;
}

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    const command = editor.command ?? fileManagerCommandForPlatform(platform);
    if (isCommandAvailable(command, { platform, env })) {
      available.push(editor.id);
    }
  }

  return available;
}

export const resolveFolderPickerLaunch = Effect.fnUntraced(function* (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<FolderPickerLaunch, OpenError> {
  switch (platform) {
    case "darwin":
      if (!isCommandAvailable("osascript", { platform, env })) {
        return yield* new OpenError({
          message: resolveFolderPickerUnavailableMessage(platform),
        });
      }
      return {
        command: "osascript",
        args: [
          "-e",
          "try",
          "-e",
          'POSIX path of (choose folder with prompt "Select a project folder")',
          "-e",
          "on error number -128",
          "-e",
          'return ""',
          "-e",
          "end try",
        ],
        isCancelled: () => false,
      };
    case "win32":
      if (!isCommandAvailable("powershell.exe", { platform, env })) {
        return yield* new OpenError({
          message: resolveFolderPickerUnavailableMessage(platform),
        });
      }
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-Command",
          [
            "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
            "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
            '$dialog.Description = "Select a project folder"',
            "$dialog.ShowNewFolderButton = $true",
            "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
          ].join("; "),
        ],
        isCancelled: () => false,
      };
    default: {
      const launch = resolveLinuxFolderPickerLaunch(env);
      if (launch) {
        return launch;
      }
      return yield* new OpenError({
        message: resolveFolderPickerUnavailableMessage(platform),
      });
    }
  }
});

export const pickFolder = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  runner: typeof runProcess = runProcess,
) =>
  Effect.gen(function* () {
    const launch = yield* resolveFolderPickerLaunch(platform, env);
    const result = yield* Effect.tryPromise({
      try: () =>
        runner(launch.command, launch.args, {
          allowNonZeroExit: true,
          maxBufferBytes: 64 * 1024,
          outputMode: "truncate",
          timeoutMs: 5 * 60 * 1000,
        }),
      catch: (cause) => new OpenError({ message: "Failed to open folder picker.", cause }),
    });

    if (launch.isCancelled(result)) {
      return null;
    }

    if (result.code !== null && result.code !== 0) {
      const detail = result.stderr.trim();
      return yield* new OpenError({
        message:
          detail.length > 0
            ? `Failed to open folder picker: ${detail}`
            : "Failed to open folder picker.",
      });
    }

    return normalizePickedFolderPath(result.stdout);
  });

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a native folder picker and return the selected path.
   */
  readonly pickFolder: () => Effect.Effect<string | null, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("ace/open") {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fnUntraced(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
): Effect.fn.Return<EditorLaunch, OpenError> {
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  if (editorDef.command) {
    return shouldUseGotoFlag(editorDef, input.cwd)
      ? { command: editorDef.command, args: ["--goto", input.cwd] }
      : { command: editorDef.command, args: [input.cwd] };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  return { command: fileManagerCommandForPlatform(platform), args: [input.cwd] };
});

export const launchDetached = (launch: EditorLaunch) =>
  Effect.gen(function* () {
    if (!isCommandAvailable(launch.command)) {
      return yield* new OpenError({ message: `Editor command not found: ${launch.command}` });
    }

    yield* Effect.callback<void, OpenError>((resume) => {
      let child;
      try {
        child = spawn(launch.command, [...launch.args], {
          detached: true,
          stdio: "ignore",
          shell: process.platform === "win32",
        });
      } catch (error) {
        return resume(
          Effect.fail(new OpenError({ message: "failed to spawn detached process", cause: error })),
        );
      }

      const handleSpawn = () => {
        child.unref();
        resume(Effect.void);
      };

      child.once("spawn", handleSpawn);
      child.once("error", (cause) =>
        resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
      );
    });
  });

const make = Effect.gen(function* () {
  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) => new OpenError({ message: "failed to load browser opener", cause }),
  });

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    pickFolder: () => pickFolder(),
    openInEditor: (input) => Effect.flatMap(resolveEditorLaunch(input), launchDetached),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
