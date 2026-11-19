import {
  marketOperation,
  MarketVerbProblem,
  type MarketVerb,
  type MarketVerbInput,
} from "@ace/mcp-server/market-verbs";
import {
  MarketEntryType,
  MarketReportReason,
  MarketSourceId,
  type MarketOperation,
} from "@ace/protocol/marketplace";
import { usageFailure } from "../output.ts";
import { parseEntry, parseRef, parseVersioned } from "./refs.ts";

/*
 * Which `marketplace.request` each `ace market` command sends (ADR 0178 §11, §12.1): one command,
 * one operation, built from the command line. The verbs agents use through `market_read` and
 * `market_publish` are the same (`@ace/mcp-server/market-verbs`), so the CLI adds no market
 * logic. Texts read from files or stdin (`@FILE`, `-`) arrive already read. Pure.
 */

export interface CommandLine {
  readonly words: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
  readonly lists?: Readonly<Record<string, readonly string[]>> | undefined;
}

const flag = (line: CommandLine, name: string): string | undefined => {
  const value = line.flags[name];
  return typeof value === "string" ? value : undefined;
};

/** A shared verb, its missing pieces said as the CLI's usage errors. */
function verb(input: MarketVerbInput, argument = "REF"): MarketOperation {
  try {
    return marketOperation(input);
  } catch (error) {
    if (!(error instanceof MarketVerbProblem)) throw error;
    const named = error.field === "version" ? argument : `--${error.field}`;
    throw usageFailure(error.message, { code: "missing_argument", argument: named });
  }
}

const entryVerb = (name: MarketVerb, line: CommandLine, extra: Partial<MarketVerbInput> = {}) =>
  verb({ verb: name, ...parseEntry(line.words[0]), ...extra });
const versionVerb = (name: MarketVerb, line: CommandLine, extra: Partial<MarketVerbInput> = {}) =>
  verb({ verb: name, ...parseVersioned(line.words[0], flag(line, "version")), ...extra });

function source(value: string | undefined, argument = "SOURCE"): string {
  if (!value || !MarketSourceId.safeParse(value).success)
    throw usageFailure(`${value ?? "That"} isn't a source.`, {
      argument,
      hint: "A source is market or git:ID; see them with ace market source list.",
    });
  return value;
}

type Builder = (line: CommandLine) => MarketOperation;

/** The operation for each command that is one request; the rest are steps in `run/market.ts`. */
export const marketActions: Readonly<Record<string, Builder>> = {
  "market.discover": () => ({ op: "discover" }),
  "market.search": (line) =>
    verb({
      verb: "search",
      query: line.words.join(" "),
      ...(flag(line, "type") ? { type: parseEntryType(flag(line, "type")) } : {}),
      ...(flag(line, "category") ? { category: flag(line, "category") } : {}),
      ...(flag(line, "source") ? { source: source(flag(line, "source"), "--source") } : {}),
      ...(flag(line, "limit") ? { limit: limit(flag(line, "limit")) } : {}),
    }),
  "market.show": (line) => {
    const ref = parseRef(line.words[0] ?? "");
    return ref.kind === "publisher"
      ? verb({ verb: "publisher", handle: ref.handle })
      : verb({
          verb: "show",
          type: ref.type,
          name: ref.name,
          ...(flag(line, "source") ? { source: source(flag(line, "source"), "--source") } : {}),
        });
  },
  "market.remove": (line) => ({ op: "remove", ...entryKey(line) }),
  "market.restore": (line) => ({ op: "turnOn", ...entryKey(line) }),
  "market.installed": () => ({ op: "installed" }),
  "market.source.list": () => ({ op: "sources" }),
  "market.source.add": (line) => ({ op: "addSource", address: line.words[0] ?? "" }),
  "market.source.remove": (line) => ({ op: "removeSource", id: source(line.words[0]) }),
  "market.source.on": (line) => ({ op: "setSource", id: source(line.words[0]), enabled: true }),
  "market.source.off": (line) => ({ op: "setSource", id: source(line.words[0]), enabled: false }),
  "market.source.refresh": (line) =>
    line.words[0] ? { op: "refresh", id: source(line.words[0]) } : { op: "refresh" },
  "market.report": (line) => {
    const ref = parseEntry(line.words[0]);
    const reason = MarketReportReason.safeParse(flag(line, "reason"));
    if (!reason.success)
      throw usageFailure("Say what's wrong with --reason.", {
        code: "missing_argument",
        argument: "--reason",
        hint: `One of ${MarketReportReason.options.join(", ")}.`,
      });
    return {
      op: "report",
      type: ref.type,
      name: ref.name,
      ...(ref.version ? { version: ref.version } : {}),
      reason: reason.data,
      note: flag(line, "note") ?? "",
    };
  },
  "market.draft.list": () => verb({ verb: "status" }),
  "market.draft.show": (line) => verb({ verb: "draft", draft: line.words[0] ?? "" }),
  "market.draft.update": (line) =>
    verb({
      verb: "draft_update",
      draft: line.words[0] ?? "",
      ...(flag(line, "version") ? { version: flag(line, "version") } : {}),
      ...(flag(line, "changelog") !== undefined ? { changelog: flag(line, "changelog") } : {}),
      ...(flag(line, "from") ? { path: flag(line, "from") } : {}),
    }),
  "market.draft.publish": (line) => verb({ verb: "draft_publish", draft: line.words[0] ?? "" }),
  "market.draft.delete": (line) => verb({ verb: "draft_delete", draft: line.words[0] ?? "" }),
  "market.status": (line) =>
    line.words[0] ? entryVerb("versions", line) : verb({ verb: "status" }),
  "market.versions": (line) => entryVerb("versions", line),
  "market.changelog": (line) =>
    versionVerb("changelog", line, { changelog: line.words[1] ?? flag(line, "changelog") }),
  "market.latest": (line) =>
    line.flags.newest
      ? entryVerb("latest", line, { clear: true })
      : entryVerb("latest", line, { version: line.words[1] }),
  "market.deprecate": (line) =>
    versionVerb(
      "deprecate",
      line,
      line.flags.clear ? { clear: true } : { note: flag(line, "note") },
    ),
  "market.visibility": (line) => {
    const visibility = line.words[1];
    if (visibility !== "listed" && visibility !== "unlisted")
      throw usageFailure(`${visibility ?? "That"} isn't a visibility.`, {
        argument: "VISIBILITY",
        hint: "Use listed or unlisted.",
      });
    return entryVerb("visibility", line, { visibility });
  },
  "market.archive": (line) => entryVerb("archive", line),
  "market.unarchive": (line) => entryVerb("unarchive", line),
  "market.withdraw": (line) => entryVerb("withdraw", line, { reason: flag(line, "reason") }),
  "market.transfer": (line) => entryVerb("transfer", line, { to: flag(line, "to") }),
  "market.transfer.accept": (line) =>
    verb({ verb: "transfer_answer", transfer: line.words[0] ?? "", accept: true }),
  "market.transfer.decline": (line) =>
    verb({ verb: "transfer_answer", transfer: line.words[0] ?? "", accept: false }),
  "market.delete": (line) => entryVerb("delete", line),
  "market.signals": (line) => entryVerb("signals", line),
  "market.appeal": (line) =>
    versionVerb("appeal", line, {
      note: flag(line, "note"),
      ...(flag(line, "replacement") ? { replacement: flag(line, "replacement") } : {}),
    }),
  "market.profile.show": () => verb({ verb: "status" }),
  "market.profile.create": (line) => ({
    op: "publish",
    request: {
      action: "createProfile",
      profile: {
        handle: (flag(line, "handle") ?? "").replace(/^@/, ""),
        displayName: flag(line, "name") ?? "",
        bio: flag(line, "bio") ?? "",
        links: [],
      },
    },
  }),
  "market.profile.edit": (line) => ({
    op: "publish",
    request: {
      action: "editProfile",
      profile: {
        ...(flag(line, "name") ? { displayName: flag(line, "name") } : {}),
        ...(flag(line, "bio") !== undefined ? { bio: flag(line, "bio") } : {}),
      },
    },
  }),
  "market.profile.handle": (line) => verb({ verb: "handle", handle: line.words[0] ?? "" }),
  "market.profile.pins": (line) => ({
    op: "publish",
    request: {
      action: "setPins",
      entries: line.words.map((word) => {
        const ref = parseEntry(word);
        return { type: ref.type, name: ref.name };
      }),
    },
  }),
  "market.verification.show": () => verb({ verb: "verification" }),
  "market.verification.apply": (line) =>
    verb({
      verb: "verification_apply",
      ...(flag(line, "domain") ? { domain: flag(line, "domain") } : {}),
      ...(flag(line, "github") ? { github: flag(line, "github") } : {}),
    }),
  "market.verification.check": () => verb({ verb: "verification_check" }),
};

function entryKey(line: CommandLine) {
  const ref = parseEntry(line.words[0]);
  return { type: ref.type, name: ref.name };
}

function parseEntryType(value: string | undefined) {
  const type = MarketEntryType.safeParse(value);
  if (!type.success)
    throw usageFailure(`${value} isn't a market type.`, {
      argument: "--type",
      hint: `Types: ${MarketEntryType.options.join(", ")}.`,
    });
  return type.data;
}

function limit(value: string | undefined): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100)
    throw usageFailure(`${value} isn't a limit from 1 to 100.`, { argument: "--limit" });
  return number;
}

/** The operation `id` sends for this command line. */
export function marketAction(id: string, line: CommandLine): MarketOperation {
  const build = marketActions[id];
  if (!build) throw new Error(`No market action for ${id}`);
  return build(line);
}
