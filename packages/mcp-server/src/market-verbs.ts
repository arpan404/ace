import { z } from "zod";
import {
  MarketEntryType,
  MarketVersion,
  type MarketDraftCheck,
  type MarketDraftChecked,
  type MarketDraftSource,
  type MarketListingEdit,
  type MarketOperation,
  type MarketPublishAction,
} from "@ace/protocol/marketplace";

/*
 * The market's verbs as people and agents say them (ADR 0176 §11, §12): `ace market …` and the
 * `market_read`/`market_publish` tools build one of these, and this module turns it into the
 * `marketplace.request` operation that does it. One verb, one operation, except `describe`
 * (a listing edit over the entry's current listing). The market's own logic stays in the daemon.
 * Pure.
 */

export const marketReadVerbs = [
  "search",
  "show",
  "publisher",
  "installed",
  "status",
  "versions",
  "check",
  "draft",
  "signals",
  "verification",
] as const;
/** What an agent may do itself (the daemon's allowlist, ADR 0176 §12.5). */
export const marketPublishVerbs = [
  "draft_create",
  "draft_update",
  "draft_delete",
  "draft_publish",
] as const;
/** The person's: asked for by an agent, they become a request in its thread. */
export const marketPersonVerbs = [
  "describe",
  "changelog",
  "latest",
  "deprecate",
  "visibility",
  "archive",
  "unarchive",
  "appeal",
  "withdraw",
  "transfer",
  "transfer_answer",
  "handle",
  "delete",
  "verification_apply",
  "verification_check",
  "install",
] as const;

const text = (max: number) => z.string().max(max);
export const MarketVerbFields = z.strictObject({
  type: MarketEntryType.optional(),
  name: z.string().min(1).max(64).optional(),
  version: z.string().max(64).optional(),
  source: z.string().max(40).optional(),
  query: text(200).optional(),
  category: text(40).optional(),
  handle: text(40).optional(),
  path: z.string().min(1).max(4096).optional().describe("A folder on this machine"),
  suit: z.string().max(80).optional().describe("One of the person's Suits, by id"),
  draft: z.string().max(60).optional(),
  changelog: text(4000).optional(),
  note: text(2000).optional(),
  reason: text(500).optional(),
  to: text(40).optional(),
  transfer: z.string().max(60).optional(),
  accept: z.boolean().optional(),
  replacement: z.string().max(64).optional(),
  title: text(120).optional(),
  line: text(300).optional(),
  description: text(8192).optional(),
  categories: z.array(text(40)).max(3).optional(),
  keywords: z.array(text(40)).max(16).optional(),
  links: z.array(text(2100)).max(5).optional().describe("Label=https://… or an address"),
  visibility: z.enum(["listed", "unlisted"]).optional(),
  domain: text(253).optional(),
  github: text(40).optional(),
  /** `deprecate` without a note clears it; `latest` without a version follows the newest. */
  clear: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type MarketVerbFields = z.infer<typeof MarketVerbFields>;

export type MarketVerb =
  | (typeof marketReadVerbs)[number]
  | (typeof marketPublishVerbs)[number]
  | (typeof marketPersonVerbs)[number];
export type MarketVerbInput = MarketVerbFields & { readonly verb: MarketVerb };

/** A verb that couldn't become an operation: what's missing, as one sentence. */
export class MarketVerbProblem extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

function need<K extends keyof MarketVerbFields>(
  input: MarketVerbInput,
  field: K,
  what: string,
): NonNullable<MarketVerbFields[K]> {
  const value = input[field];
  if (value === undefined || value === "") throw new MarketVerbProblem(field, `Name ${what}.`);
  return value as NonNullable<MarketVerbFields[K]>;
}
const entry = (input: MarketVerbInput) => ({
  type: need(input, "type", "the entry's type"),
  name: need(input, "name", "the entry's name"),
});
function version(input: MarketVerbInput): string {
  const value = need(input, "version", "the version");
  if (!MarketVersion.safeParse(value).success)
    throw new MarketVerbProblem("version", `${value} isn't a version like 1.2.0.`);
  return value;
}
const versioned = (input: MarketVerbInput) => ({ ...entry(input), version: version(input) });
const publish = (request: MarketPublishAction): MarketOperation => ({ op: "publish", request });

/** Where a draft's files come from: a folder, or one of the person's Suits. */
export function draftSource(input: MarketVerbInput): MarketDraftSource {
  if (input.suit) return { kind: "suit", id: input.suit };
  return { kind: "folder", path: need(input, "path", "the folder (path) or the Suit (suit)") };
}

/** One operation for a single-step verb; `describe` and `install` go through their own steps. */
export function marketOperation(input: MarketVerbInput): MarketOperation {
  switch (input.verb) {
    case "search":
      return {
        op: "search",
        query: input.query ?? "",
        ...(input.type ? { type: input.type } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.source ? { source: input.source } : {}),
        offset: 0,
        limit: input.limit ?? 50,
      };
    case "show":
      return { op: "read", source: input.source ?? "market", ...entry(input) };
    case "publisher":
      return { op: "publisher", handle: need(input, "handle", "the publisher").replace(/^@/, "") };
    case "installed":
      return { op: "installed" };
    case "status":
      return publish({ action: "me" });
    case "versions":
      return publish({ action: "entry", ...entry(input) });
    case "check":
      return publish({ action: "draftCheck", ...entry(input), source: draftSource(input) });
    case "draft":
      return publish({ action: "draftRead", id: need(input, "draft", "the draft") });
    case "signals":
      return publish({ action: "signals", ...entry(input) });
    case "verification":
      return publish({ action: "verification" });
    case "draft_create":
      return publish({
        action: "draftCreate",
        ...versioned(input),
        source: draftSource(input),
        ...(input.changelog ? { changelog: input.changelog } : {}),
      });
    case "draft_update":
      return publish({
        action: "draftUpdate",
        id: need(input, "draft", "the draft"),
        ...(input.version ? { version: version(input) } : {}),
        ...(input.changelog !== undefined ? { changelog: input.changelog } : {}),
        ...(input.path || input.suit ? { source: draftSource(input) } : {}),
      });
    case "draft_delete":
      return publish({ action: "draftDelete", id: need(input, "draft", "the draft") });
    case "draft_publish":
      return publish({ action: "draftPublish", id: need(input, "draft", "the draft") });
    case "describe":
      throw new MarketVerbProblem(
        "verb",
        "describe edits the current listing: use describeListing.",
      );
    case "changelog":
      return publish({
        action: "changelog",
        ...versioned(input),
        text: need(input, "changelog", "the changelog"),
      });
    case "latest":
      return publish({
        action: "latest",
        ...entry(input),
        version: input.clear ? null : version(input),
      });
    case "deprecate":
      return publish({
        action: "deprecate",
        ...versioned(input),
        note: input.clear ? null : need(input, "note", "the deprecation note"),
      });
    case "visibility":
      return publish({
        action: "visibility",
        ...entry(input),
        visibility: need(input, "visibility", "listed or unlisted"),
      });
    case "archive":
    case "unarchive":
      return publish({ action: "archive", ...entry(input), archived: input.verb === "archive" });
    case "appeal":
      return publish({
        action: "appeal",
        ...versioned(input),
        note: need(input, "note", "your note to the maintainers"),
        ...(input.replacement ? { replacement: input.replacement } : {}),
      });
    case "withdraw":
      return publish({
        action: "withdraw",
        ...entry(input),
        ...(input.version ? { version: version(input) } : {}),
        reason: need(input, "reason", "why it's withdrawn (reason)"),
      });
    case "transfer":
      return publish({
        action: "transfer",
        ...entry(input),
        to: need(input, "to", "who receives it").replace(/^@/, ""),
      });
    case "transfer_answer":
      return publish({
        action: "transferAnswer",
        id: need(input, "transfer", "the transfer"),
        accept: input.accept === true,
      });
    case "handle":
      return publish({
        action: "changeHandle",
        handle: need(input, "handle", "the new handle").replace(/^@/, ""),
      });
    case "delete":
      return publish({ action: "deleteEntry", ...entry(input) });
    case "verification_apply":
      return publish({
        action: "applyVerification",
        ...(input.domain ? { domain: input.domain } : {}),
        ...(input.github ? { github: input.github } : {}),
      });
    case "verification_check":
      return publish({ action: "checkVerification" });
    case "install":
      return {
        op: "prepare",
        source: input.source ?? "market",
        ...entry(input),
        ...(input.version ? { version: version(input) } : {}),
      };
  }
}

/** "Docs=https://…" names a link; a bare address is labelled by its host. */
function link(value: string): { label: string; url: string } {
  const at = value.indexOf("=");
  if (at > 0 && !value.slice(0, at).includes("/"))
    return { label: value.slice(0, at).trim().slice(0, 40), url: value.slice(at + 1).trim() };
  let label = value;
  try {
    label = new URL(value).hostname.replace(/^www\./, "");
  } catch {
    // Not an address; the market says so.
  }
  return { label: label.slice(0, 40), url: value };
}

/** `describe`: the entry's current listing with the given words changed. */
export function describeListing(
  current: MarketListingEdit,
  input: MarketVerbInput,
): MarketOperation {
  const listing: MarketListingEdit = {
    ...current,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.line !== undefined ? { line: input.line } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.categories ? { categories: input.categories } : {}),
    ...(input.keywords ? { keywords: input.keywords } : {}),
    ...(input.links ? { links: input.links.map(link) } : {}),
  };
  return publish({ action: "listing", ...entry(input), listing });
}

/**
 * The confirmation a draft from a folder needs (ADR 0174 §11): every binary file kept and every
 * flagged text accepted. Only for a caller who has read the check (`--yes`, or an agent that
 * passed `confirm`). A blocking finding is never accepted.
 */
export function acceptCheck(check: MarketDraftCheck): MarketDraftChecked {
  return {
    hash: check.hash,
    binaries: check.files.filter((file) => file.binary).map((file) => file.path),
    accepted: check.findings.filter((finding) => !finding.blocking).map((finding) => finding.text),
  };
}
