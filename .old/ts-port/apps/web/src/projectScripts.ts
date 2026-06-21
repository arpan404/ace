import {
  MAX_SCRIPT_ID_LENGTH,
  SCRIPT_RUN_COMMAND_PATTERN,
  type KeybindingCommand,
  type ProjectScript,
} from "@ace/contracts";
import { Schema } from "effect";

const PROJECT_SCRIPT_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROJECT_SCRIPT_ENV_FILE_SEGMENT_PATTERN = /^[^/\\]+$/;

export const DEFAULT_PROJECT_SCRIPT_ENV_FILE_PATH = ".env";

function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export const commandForProjectScript = (scriptId: string): KeybindingCommand =>
  SCRIPT_RUN_COMMAND_PATTERN.makeUnsafe(`script.${scriptId}.run`);

export function projectScriptIdFromCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!Schema.is(SCRIPT_RUN_COMMAND_PATTERN)(trimmed)) {
    return null;
  }
  const [prefix, , suffix] = SCRIPT_RUN_COMMAND_PATTERN.parts;
  return trimmed.slice(prefix.literal.length, -suffix.literal.length);
}

export function nextProjectScriptId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    suffix += 1;
  }

  // This last-resort fallback only triggers after exhausting thousands of suffixes.
  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    ACE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.ACE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function formatProjectScriptEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function formatProjectScriptEnvFile(env: Record<string, string> | undefined): string {
  const formatted = formatProjectScriptEnv(env);
  return formatted ? `${formatted}\n` : "";
}

export function normalizeProjectScriptEnvFilePath(value: string): string {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (!normalized) {
    throw new Error("Environment file path is required.");
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("Environment file path must be relative to the worktree.");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Environment file path cannot escape the worktree.");
  }
  for (const segment of segments) {
    if (!PROJECT_SCRIPT_ENV_FILE_SEGMENT_PATTERN.test(segment)) {
      throw new Error("Environment file path contains an invalid segment.");
    }
  }
  return segments.join("/");
}

export function parseProjectScriptEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [index, rawLine] of value.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Environment line ${index + 1} must use KEY=value.`);
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!PROJECT_SCRIPT_ENV_KEY_PATTERN.test(key)) {
      throw new Error(
        `Environment key "${key}" must start with a letter or underscore and contain only letters, numbers, and underscores.`,
      );
    }
    env[key] = line.slice(separatorIndex + 1);
  }
  return env;
}

export function primaryProjectScript(scripts: ProjectScript[]): ProjectScript | null {
  const regular = scripts.find((script) => !script.runOnWorktreeCreate);
  return regular ?? scripts[0] ?? null;
}

export function setupProjectScript(scripts: ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
