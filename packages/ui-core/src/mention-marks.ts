import type { CatalogEntry, ProviderKind } from "@ace/protocol";

/*
 * Which picture stands for a reference in the `@` and `/` menus and in its chip, on every
 * client: a file's kind, a folder, the provider whose agent or thread it is, a connected app's
 * brand mark, a Spade bot's face or a club's faces. Pure: a client draws the mark it names.
 */

export type MentionMark =
  /** A file: a client draws its kind (by name) as its attachments do. */
  | { kind: "file"; path: string }
  | { kind: "folder" }
  /** A provider's agent or a thread run by one: the provider's mark. */
  | { kind: "provider"; provider: ProviderKind }
  /**
   * A connected app: its brand mark by the catalogue ids it may go by, best first. A client
   * draws the first it has art for, else `fallback`'s glyph, never a made-up monogram.
   */
  | { kind: "app"; candidates: readonly string[]; fallback: CatalogEntry["kind"] }
  /** A catalog entry with no better picture: its kind's glyph. */
  | { kind: "glyph"; glyph: CatalogEntry["kind"] | "thread" | "tab" | "agent-thread" };

/** A path from the file index: a folder ends in `/`. */
export function pathMark(path: string): MentionMark {
  return path.endsWith("/") ? { kind: "folder" } : { kind: "file", path };
}

/**
 * The catalogue ids an app's or server's name may match, best first: `Google Drive` →
 * `google-drive`, `googledrive`; `linear-mcp-server` → `linear`; `slack@claude-plugins` → `slack`.
 */
export function appCandidates(name: string): string[] {
  const base = name
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/^.*[:/]/, "")
    .replace(/[\s._-]*(mcp|server|connector|app|plugin)\b/g, " ")
    .trim();
  const words = base.split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return [];
  const joined = words.join("");
  const hyphened = words.join("-");
  return [...new Set([hyphened, joined])];
}

/** What picture a catalog entry gets in the menus and in its chip. */
export function catalogMark(
  entry: Pick<CatalogEntry, "kind" | "name" | "source" | "invocation">,
): MentionMark {
  const invocation = entry.invocation;
  if (invocation.type === "mention" && invocation.path.startsWith("app://"))
    return { kind: "app", candidates: appCandidates(entry.name), fallback: entry.kind };
  if (invocation.type === "tool")
    return {
      kind: "app",
      candidates: appCandidates(invocation.server || entry.name),
      fallback: entry.kind,
    };
  if (entry.kind === "plugin")
    return {
      kind: "app",
      candidates: appCandidates(entry.source.plugin ?? entry.name),
      fallback: entry.kind,
    };
  const provider = entry.source.provider;
  if (entry.kind === "agent" && provider !== "ace") return { kind: "provider", provider };
  return { kind: "glyph", glyph: entry.kind };
}

/**
 * A catalog mention's `icon` naming a connected app's mark by its candidate catalogue ids
 * (`app:linear,linear-app`): display metadata the chip keeps in the composer and the sent message.
 */
export function appIcon(candidates: readonly string[]): string {
  return `app:${candidates.join(",")}`;
}
export function appIconCandidates(icon: string | undefined): string[] | undefined {
  if (!icon?.startsWith("app:")) return undefined;
  const candidates = icon.slice(4).split(",").filter(Boolean);
  return candidates.length ? candidates : undefined;
}
