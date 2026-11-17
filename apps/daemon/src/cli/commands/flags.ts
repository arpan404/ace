import type { FlagSpec } from "./spec.ts";

/** Flags several commands share, spelled once so they read the same everywhere. */
export const idempotencyKey: FlagSpec = {
  name: "idempotency-key",
  value: "KEY",
  summary: "Run this mutation at most once; retry with the same key",
};
export const projectRef: FlagSpec = {
  name: "project",
  value: "PROJECT",
  summary: "A project id, name or path",
};
export const providerName: FlagSpec = {
  name: "provider",
  value: "PROVIDER",
  summary: "codex, claude, cursor, opencode, antigravity or pi",
};
export const modelName: FlagSpec = { name: "model", value: "MODEL", summary: "The model to use" };
export const follow: FlagSpec = {
  name: "follow",
  short: "f",
  summary: "Keep printing as it changes; JSON Lines with --json",
};
export const limit: FlagSpec = { name: "limit", value: "N", summary: "At most N results" };
export const after: FlagSpec = {
  name: "after",
  value: "CURSOR",
  summary: "The page after this cursor (from the last page's next)",
};
export const threadRef: FlagSpec = {
  name: "thread",
  value: "THREAD",
  summary: "The thread; defaults to ACE_THREAD_ID in an agent's shell",
};
export const outputPath: FlagSpec = {
  name: "output",
  value: "PATH",
  summary: "Where to write the file",
};

/** The release the new grammar ships in; old spellings count their window from it. */
export const grammarRelease = "0.0.24";
