import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  MarketListingFile,
  MarketNamedFile,
  type MarketEntryType,
  type MarketProblem,
} from "@ace/protocol/marketplace";
import { listingBytes } from "./limits.ts";

/*
 * The words an entry is listed with: its own files say them (a Suit's suit.json, a skill's
 * SKILL.md frontmatter, a plugin's manifest, a recipe's bot.json), and an optional `market.json`
 * beside them may set a title, one line, a longer description, up to three categories and some
 * keywords. Pure.
 */

export interface Listing {
  title: string;
  line: string;
  description: string;
  categories: string[];
  keywords: string[];
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
export function text(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes) return undefined;
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function json(bytes: Uint8Array | undefined): z.infer<typeof MarketNamedFile> {
  try {
    const parsed = MarketNamedFile.safeParse(JSON.parse(text(bytes) ?? ""));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** A Markdown file's YAML frontmatter, and the first `#` heading of its body. */
export function frontmatter(markdown: string): {
  data: Record<string, unknown>;
  heading: string | undefined;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  let data: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed: unknown = parseYaml(match[1] ?? "", { maxAliasCount: 16 });
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        data = parsed as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  const body = match ? markdown.slice(match[0].length) : markdown;
  const heading = /^#\s+(.+?)\s*$/m.exec(body)?.[1];
  return { data, heading, body };
}

const pluginManifests = [
  "ace-plugin.json",
  "plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
];

/** What the entry's own files say, before `market.json`. */
function own(type: MarketEntryType, name: string, files: ReadonlyMap<string, Uint8Array>) {
  switch (type) {
    case "suit": {
      const suit = json(files.get("suit.json"));
      return { title: suit.name, description: suit.description };
    }
    case "spade-skill": {
      const skill = frontmatter(text(files.get("SKILL.md")) ?? "");
      const description =
        typeof skill.data["description"] === "string" ? skill.data["description"] : undefined;
      return { title: skill.heading, description };
    }
    case "spade-plugin":
    case "ace-plugin": {
      const path = pluginManifests.find((candidate) => files.has(candidate));
      const plugin = json(path ? files.get(path) : undefined);
      return {
        title: plugin.name === name ? undefined : plugin.name,
        description: plugin.description,
      };
    }
    case "spade-bot": {
      const bot = json(files.get("bot.json"));
      return { title: bot.name, description: bot.blurb };
    }
  }
}

const firstLine = (value: string | undefined) =>
  (value ?? "")
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim() ?? "";

/** The listing's words, and problems with `market.json` (it is checked, never guessed). */
export function describeEntry(
  type: MarketEntryType,
  name: string,
  files: ReadonlyMap<string, Uint8Array>,
): { listing: Listing; problems: MarketProblem[] } {
  const problems: MarketProblem[] = [];
  let extra: MarketListingFile = {};
  const raw = files.get("market.json");
  if (raw) {
    if (raw.byteLength > listingBytes)
      problems.push({ path: "market.json", message: `market.json is over ${listingBytes} bytes` });
    else
      try {
        const parsed = MarketListingFile.safeParse(JSON.parse(text(raw) ?? ""));
        if (parsed.success) extra = parsed.data;
        else
          for (const issue of parsed.error.issues.slice(0, 10))
            problems.push({
              path: "market.json",
              message: `${issue.path.join(".") || "market.json"}: ${issue.message}`,
            });
      } catch {
        problems.push({ path: "market.json", message: "market.json isn't JSON" });
      }
  }
  const base = own(type, name, files);
  const description = extra.description ?? base.description ?? "";
  const title = (extra.title ?? base.title ?? name).trim().slice(0, 120) || name;
  return {
    listing: {
      title,
      line: (extra.line ?? firstLine(description)).slice(0, 300),
      description: description.slice(0, 8192),
      categories: extra.categories ?? [],
      keywords: extra.keywords ?? [],
    },
    problems,
  };
}
