/**
 * Shared utilities for text generation layers (Codex, Claude, etc.).
 *
 * @module textGenerationUtils
 */
import { Schema } from "effect";

import { TextGenerationError } from "@ace/contracts";

import { existsSync } from "node:fs";
import { join } from "node:path";

export function isGitRepository(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

/** Normalise a raw thread title to a compact single-line sidebar-safe label. */
export function sanitizeThreadTitle(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= 50) {
    return normalized;
  }

  return `${normalized.slice(0, 47).trimEnd()}...`;
}

function sanitizeSummaryList(
  raw: ReadonlyArray<string>,
  fallbackLimit: number,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const entry of raw) {
    const normalized = entry.trim().replace(/\s+/g, " ");
    if (normalized.length === 0) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(normalized);
    if (next.length >= fallbackLimit) {
      break;
    }
  }
  return next;
}

export function sanitizeWorkspaceSummaryHeadline(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[.]+$/g, "")
    .replace(/\s+/g, " ");

  if (!normalized || normalized.length === 0) {
    return "Workspace summary";
  }

  if (normalized.length <= 72) {
    return normalized;
  }

  return `${normalized.slice(0, 69).trimEnd()}...`;
}

export function sanitizeWorkspaceSummaryParagraph(raw: string): string {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (normalized.length > 0) {
    return normalized;
  }
  return "The workspace contains uncommitted implementation changes.";
}

export function sanitizeWorkspaceSummaryKeyChanges(
  raw: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return sanitizeSummaryList(raw, 4);
}

export function sanitizeWorkspaceSummaryRisks(raw: ReadonlyArray<string>): ReadonlyArray<string> {
  return sanitizeSummaryList(raw, 3);
}

function sanitizeRecommendationField(raw: string, fallback: string, maxLength: number): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\s+/g, " ");

  if (!normalized || normalized.length === 0) {
    return fallback;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function sanitizeNewThreadRecommendations(
  raw: ReadonlyArray<{
    readonly title: string;
    readonly description: string;
    readonly prompt: string;
  }>,
): ReadonlyArray<{
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
}> {
  const recommendations: Array<{ title: string; description: string; prompt: string }> = [];
  const seenPrompts = new Set<string>();
  for (const entry of raw) {
    const title = sanitizeRecommendationField(entry.title, "", 64);
    const description = sanitizeRecommendationField(entry.description, "", 120);
    const prompt = entry.prompt.trim().replace(/\s+/g, " ");
    if (
      !isUsefulNewThreadRecommendation({ title, description, prompt }) ||
      seenPrompts.has(prompt)
    ) {
      continue;
    }
    seenPrompts.add(prompt);
    recommendations.push({
      title,
      description,
      prompt: prompt.length <= 500 ? prompt : `${prompt.slice(0, 497).trimEnd()}...`,
    });
    if (recommendations.length >= 3) {
      break;
    }
  }

  return recommendations.length === 3 ? recommendations : [];
}

function isUsefulNewThreadRecommendation(input: {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
}): boolean {
  if (input.title.length < 4 || input.description.length < 12 || input.prompt.length < 20) {
    return false;
  }

  const joined = `${input.title} ${input.description} ${input.prompt}`.toLowerCase();
  const genericFragments = [
    "start a task",
    "continue latest work",
    "continue recent work",
    "continue the latest",
    "continue with the next useful",
    "pick up from the recent",
    "pick up from the latest",
    "recent turns only contain greetings",
    "state the coding task clearly",
  ];
  return !genericFragments.some((fragment) => joined.includes(fragment));
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (Schema.is(TextGenerationError)(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: `${fallback}: ${error.message}`,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
