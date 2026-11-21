import type { MarketProblem } from "@ace/protocol/marketplace";
import { isMap, isScalar, LineCounter, parseDocument, stringify } from "yaml";

/*
 * `SKILL.md` as the Agent Skills specification defines it (ADR 0202 §1): YAML front matter with
 * `name` and `description` required and `license`, `compatibility`, `metadata` and the
 * experimental `allowed-tools` optional, then a Markdown body. Spade reads, checks, imports and
 * exports skills through this one reader; the market's skill check and `ace bot check` use it too.
 *
 * Fields the spec doesn't define are kept and never refused. An export carries them under
 * `metadata` as `spade.field.<name>` (their value as JSON), because the spec's validator allows no
 * other top-level field; an import lifts them back, so a skill survives the trip both ways. Pure.
 */

/** The front matter fields the specification defines, in the order an export writes them. */
export const specFields = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
] as const;

/** The specification's limits. */
export const skillMdLimits = { name: 64, description: 1024, compatibility: 500 } as const;

/** Lower-case letters and digits in runs joined by single hyphens, as the spec names skills. */
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Where an export keeps a field the specification doesn't define. */
const fieldPrefix = "spade.field.";

/** Which version of this mapping an export follows, written as `metadata.spade.version`. */
export const skillExportVersion = "1";

export interface SkillMd {
  /** `name` when it is a string. */
  name: string | undefined;
  /** `description`, trimmed; empty when missing. */
  description: string;
  license: string | undefined;
  compatibility: string | undefined;
  /** `metadata` entries whose value is a string, `spade.` keys included. */
  metadata: Record<string, string>;
  /**
   * `allowed-tools`, split on spaces. Information only: it grants nothing, and Spade's gate reads
   * every call of a skill that lists a tool as it reads any other call (ADR 0202 decision 4).
   */
  allowedTools: string[];
  /** Fields the specification doesn't define, kept by name with their values. */
  unused: Record<string, unknown>;
  /** `disable-model-invocation: true`: the person starts it, the model never loads it alone. */
  manual: boolean;
  /** Everything after the front matter. */
  body: string;
}

interface Front {
  /** The YAML between the `---` lines, or `undefined` when there is none. */
  yaml: string | undefined;
  body: string;
}

function split(markdown: string): Front {
  const match = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/.exec(markdown);
  if (!match) return { yaml: undefined, body: markdown };
  return { yaml: match[1] ?? "", body: markdown.slice(match[0].length) };
}

interface Parsed {
  data: Record<string, unknown> | undefined;
  /** The line in SKILL.md each top-level key is on. */
  lines: Map<string, number>;
  error: string | undefined;
}

function parse(yaml: string): Parsed {
  const lineCounter = new LineCounter();
  const document = parseDocument(yaml, { lineCounter, maxAliasCount: 16, uniqueKeys: true });
  const lines = new Map<string, number>();
  if (document.errors.length > 0)
    return { data: undefined, lines, error: document.errors[0]?.message.split("\n")[0] };
  if (document.contents === null) return { data: {}, lines, error: undefined };
  if (!isMap(document.contents))
    return { data: undefined, lines, error: "it isn't a list of fields" };
  for (const item of document.contents.items) {
    if (!isScalar(item.key) || item.key.range === undefined || item.key.range === null) continue;
    // The front matter starts on SKILL.md's second line.
    lines.set(String(item.key.value), lineCounter.linePos(item.key.range[0]).line + 1);
  }
  const data: unknown = document.toJS({ maxAliasCount: 16 });
  return {
    data: data && typeof data === "object" ? (data as Record<string, unknown>) : {},
    lines,
    error: undefined,
  };
}

const known = new Set<string>(specFields);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

function tools(value: unknown): string[] {
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((tool) => typeof tool === "string");
  return [];
}

function strings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function reading(data: Record<string, unknown>, body: string): SkillMd {
  const unused = Object.fromEntries(Object.entries(data).filter(([key]) => !known.has(key)));
  return {
    name: str(data["name"]),
    description: str(data["description"])?.trim() ?? "",
    license: str(data["license"]),
    compatibility: str(data["compatibility"]),
    metadata: strings(data["metadata"]),
    allowedTools: tools(data["allowed-tools"]),
    unused,
    manual: data["disable-model-invocation"] === true,
    body,
  };
}

/** What `markdown` says, read leniently: a field that doesn't fit reads as missing. */
export function readSkillMd(markdown: string): SkillMd {
  const front = split(markdown);
  const data = front.yaml === undefined ? {} : (parse(front.yaml).data ?? {});
  return reading(data, front.body);
}

/**
 * Where `markdown`, the `SKILL.md` of the folder `folder`, breaks the specification, each problem
 * at its line. `path` is how the file is named in the problems. Fields the spec doesn't define are
 * never a problem. Pure.
 */
export function skillMdProblems(
  folder: string,
  markdown: string,
  path = "SKILL.md",
): MarketProblem[] {
  const front = split(markdown);
  if (front.yaml === undefined)
    return [{ path, line: 1, message: `${path} must start with front matter between --- lines` }];
  const parsed = parse(front.yaml);
  if (!parsed.data)
    return [{ path, line: 1, message: `${path}'s front matter doesn't read: ${parsed.error}` }];
  const data = parsed.data;
  const problems: MarketProblem[] = [];
  const at = (key: string, message: string) =>
    problems.push({ path, line: parsed.lines.get(key) ?? 1, message });

  const name = data["name"];
  if (typeof name !== "string" || name === "")
    at("name", `${path}'s front matter needs name: ${folder}`);
  else {
    if (name.length > skillMdLimits.name)
      at("name", `name is over ${skillMdLimits.name} characters`);
    if (!namePattern.test(name))
      at(
        "name",
        "name takes lower-case letters, digits and single hyphens, not at its start or end",
      );
    if (name !== folder) at("name", `name must be the folder's name, ${folder}`);
  }

  const description = data["description"];
  if (typeof description !== "string" || description.trim() === "")
    at("description", `${path}'s front matter needs a description`);
  else if (description.length > skillMdLimits.description)
    at("description", `description is over ${skillMdLimits.description} characters`);

  if ("license" in data && typeof data["license"] !== "string")
    at("license", "license must be text: a licence's name or a file in the skill");

  if ("compatibility" in data) {
    const compatibility = data["compatibility"];
    if (typeof compatibility !== "string" || compatibility === "")
      at("compatibility", "compatibility must be text");
    else if (compatibility.length > skillMdLimits.compatibility)
      at("compatibility", `compatibility is over ${skillMdLimits.compatibility} characters`);
  }

  if ("metadata" in data) {
    const metadata = data["metadata"];
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
      at("metadata", "metadata must be a list of keys, each with a text value");
    else
      for (const [key, value] of Object.entries(metadata))
        if (typeof value !== "string") at("metadata", `metadata.${key} must be text`);
  }

  if ("allowed-tools" in data) {
    const listed = data["allowed-tools"];
    const fits =
      typeof listed === "string" ||
      (Array.isArray(listed) && listed.every((tool) => typeof tool === "string"));
    if (!fits) at("allowed-tools", "allowed-tools must be tool names separated by spaces");
  }
  return problems;
}

/**
 * Where an exported `markdown` breaks the specification's validator, which also allows no field
 * it doesn't define. An export from [`exportSkillMd`] passes. Pure.
 */
export function exportProblems(folder: string, markdown: string): MarketProblem[] {
  const problems = skillMdProblems(folder, markdown);
  const front = split(markdown);
  const data = front.yaml === undefined ? undefined : parse(front.yaml).data;
  for (const key of Object.keys(data ?? {}))
    if (!known.has(key))
      problems.push({ path: "SKILL.md", message: `${key} isn't a field the specification has` });
  return problems;
}

/** The fields this Spade keeps but doesn't use, as the review lists them. Pure. */
export function unusedFields(skill: SkillMd): string[] {
  return Object.keys(skill.unused).filter((key) => key !== "disable-model-invocation");
}

function frontMatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringify(data, { lineWidth: 0 }).replace(/\n$/, "");
  return `---\n${yaml}\n---\n${body}`;
}

/** Where a skill came from, as an export writes it in `metadata.spade.source`. */
export interface ExportFacts {
  source: string;
}

/**
 * `markdown` as a folder that passes the specification's validator: the spec's fields as they
 * were, fields it doesn't define under `metadata.spade.field.<name>` as JSON, and
 * `metadata.spade.version` and `metadata.spade.source`. The body is kept byte for byte. Pure.
 */
export function exportSkillMd(markdown: string, facts: ExportFacts): string {
  const front = split(markdown);
  const data = (front.yaml === undefined ? undefined : parse(front.yaml).data) ?? {};
  const metadata: Record<string, string> = { ...strings(data["metadata"]) };
  for (const [key, value] of Object.entries(data))
    if (!known.has(key)) metadata[`${fieldPrefix}${key}`] = JSON.stringify(value);
  metadata["spade.version"] = skillExportVersion;
  metadata["spade.source"] = facts.source;
  const out: Record<string, unknown> = {};
  for (const key of specFields) {
    if (key === "metadata") out[key] = metadata;
    else if (key === "allowed-tools") {
      const listed = tools(data[key]);
      if (key in data && listed.length > 0) out[key] = listed.join(" ");
    } else if (key in data) out[key] = data[key];
  }
  return frontMatter(out, front.body);
}

/** What an import keeps of an exported skill's own `spade.` keys. */
export interface Imported {
  /** SKILL.md as Spade stores it. */
  markdown: string;
  /** `metadata.spade.source`, when the skill says where it came from. */
  source: string | undefined;
}

/**
 * `markdown` as Spade stores an imported skill: unchanged, unless an export put fields under
 * `metadata.spade.field.<name>`; those go back to the top level, and `spade.version` and
 * `spade.source` are read and taken out, so importing an export gives back the skill that was
 * exported. Other `metadata` stays. Pure.
 */
export function importSkillMd(markdown: string): Imported {
  const front = split(markdown);
  const data = front.yaml === undefined ? undefined : parse(front.yaml).data;
  const metadata = data?.["metadata"];
  if (!data || !metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return { markdown, source: undefined };
  const entries = Object.entries(metadata as Record<string, unknown>);
  const ours = (key: string) =>
    key === "spade.version" || key === "spade.source" || key.startsWith(fieldPrefix);
  if (!entries.some(([key]) => ours(key))) return { markdown, source: undefined };
  const source = str((metadata as Record<string, unknown>)["spade.source"]);
  const kept = Object.fromEntries(entries.filter(([key]) => !ours(key)));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key !== "metadata") out[key] = value;
    else if (Object.keys(kept).length > 0) out[key] = kept;
  }
  for (const [key, value] of entries) {
    if (!key.startsWith(fieldPrefix) || typeof value !== "string") continue;
    const field = key.slice(fieldPrefix.length);
    if (!field || known.has(field)) continue;
    out[field] = liftValue(value);
  }
  return { markdown: frontMatter(out, front.body), source };
}

function liftValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
