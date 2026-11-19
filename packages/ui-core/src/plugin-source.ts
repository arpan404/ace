import { z } from "zod";

/*
 * Where a plugin is installed from, as people type it: a repository, a branch or tag, and the
 * plugin's name in that repository's marketplace. Every client checks and writes these alike.
 */

/**
 * Where a plugin comes from: `owner/name` (GitHub), an https or ssh git URL, or an absolute
 * path to a local repository. The daemon fetches it with git and reads its marketplace.
 */
export const PluginRepository = z
  .string()
  .trim()
  .min(1, "Enter a repository.")
  .refine(
    (value) =>
      /^[\w.-]+\/[\w.-]+$/.test(value) ||
      /^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)\S+$/.test(value) ||
      value.startsWith("/"),
    "Use owner/name, a git URL, or an absolute path to a local repository.",
  )
  .transform((value) =>
    /^[\w.-]+\/[\w.-]+$/.test(value) ? `https://github.com/${value}.git` : value,
  );

/** A branch, tag or commit, as git accepts it for a fetch. */
export const PluginRef = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,255}$/, "Use a branch, tag or commit.")
  .refine((value) => !value.includes(".."), "Use a branch, tag or commit.");

/** The plugin's name in the repository's marketplace. */
export const PluginNameInput = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
    "Use the plugin's name from the marketplace: lowercase letters, digits, dots and dashes.",
  )
  .max(64, "Plugin names are at most 64 characters.")
  .refine((value) => !value.includes("..") && !value.includes("--"), "That isn't a plugin name.");

/** "getsentry/sentry-mcp" → "sentry-mcp": the name a repository's plugin most likely has. */
export function suggestedPluginName(repository: string): string {
  return (
    repository
      .trim()
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .at(-1)
      ?.toLowerCase()
      .replace(/[^a-z0-9.-]/g, "-") ?? ""
  );
}

/** "getsentry/sentry @ main": a repository as people type it, with its ref. */
export function sourceText(repository: string, ref: string | undefined): string {
  const short = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repository)?.[1];
  const where = short ?? repository;
  return ref && ref !== "HEAD" ? `${where} @ ${ref}` : where;
}

/** Said when a repository's marketplace was read and offers nothing. */
export const emptyMarketplaceText = "This repository's marketplace lists no plugins.";
/** Said when the marketplace couldn't be read; the plugin's name is typed instead. */
export const unreadMarketplaceText = "ace couldn't read that repository's marketplace.";
