import {
  EntryBody,
  VersionBody,
  VersionManifest,
  type MarketKeySet,
} from "@ace/protocol/marketplace";
import { readArchive, type ArchiveFile } from "./archive.ts";
import { breakingChanges } from "./contracts.ts";
import { contentHash, hashFiles } from "./hash.ts";
import { typeLimits } from "./limits.ts";
import { readPackage } from "./package.ts";
import { verifyManifest } from "./signing.ts";

/*
 * The `bot.json` of a package's latest published version, read from the market's public routes
 * (ADR 0200 §7): what callers of its contracts use, so a new version can be compared with it.
 * The signer reads it with the trusted keys and refuses to sign a version that breaks it; `ace
 * bot publish` reads it before uploading, to say so at once. The I/O is passed in.
 */

export interface MarketReads {
  /** A read route's JSON; undefined when the market has nothing there (404). */
  read(path: string): Promise<unknown>;
  /** The archive stored under `hash`. */
  object(hash: string): Promise<Uint8Array>;
}

export interface Published {
  version: string;
  bot: unknown;
}

const parts = (version: string) =>
  version
    .replace(/^v/, "")
    .split(/[.+-]/)
    .map((part) => Number(part));

/** Whether dotted version `a` comes after `b` (`1.10.0` after `1.9.2`). */
function after(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let at = 0; at < Math.max(x.length, y.length); at++) {
    const [p, q] = [x[at] ?? -1, y[at] ?? -1];
    if (Number.isNaN(p) || Number.isNaN(q)) return a > b;
    if (p !== q) return p > q;
  }
  return false;
}

/**
 * The newest version of `spade-bot/<name>` published before `before` (any, without it) that
 * isn't withdrawn, and its `bot.json`; undefined when there is none. With `keys` its manifest's
 * signature is checked; without them only its bytes against the manifest's hash (a publisher's
 * own early check, which the signer repeats with its keys).
 */
export async function latestPublished(
  reads: MarketReads,
  name: string,
  options: { before?: string | undefined; keys?: MarketKeySet | undefined } = {},
): Promise<Published | undefined> {
  const path = `/v1/entries/spade-bot/${encodeURIComponent(name)}`;
  const raw = await reads.read(path);
  if (raw === undefined) return undefined;
  const page = EntryBody.safeParse(raw);
  if (!page.success) throw new Error("The market's entry page isn't in a form this build reads");
  const { before } = options;
  const latest = page.data.versions
    .filter((item) => !item.withdrawn)
    .filter((item) => before === undefined || after(before, item.version))
    .toSorted((a, b) =>
      after(a.version, b.version) ? -1 : after(b.version, a.version) ? 1 : 0,
    )[0];
  if (!latest) return undefined;
  const body = VersionBody.safeParse(
    await reads.read(`${path}/${encodeURIComponent(latest.version)}`),
  );
  if (!body.success) throw new Error("The market's version page isn't in a form this build reads");
  const manifest = options.keys
    ? verifyManifest(body.data.manifest, options.keys)
    : VersionManifest.parse(body.data.manifest.body);
  const files = readArchive(await reads.object(manifest.hash), typeLimits["spade-bot"]);
  if (contentHash(hashFiles(files)) !== manifest.hash)
    throw new Error(`${name} ${latest.version}'s stored bytes don't make its hash`);
  const bot = botJsonOf(files);
  if (bot === undefined) throw new Error(`${name} ${latest.version} has no bot.json that reads`);
  return { version: latest.version, bot };
}

/** A `bot.json` value's contracts, as the market's reader reads them. */
const contractsOf = (bot: unknown) =>
  typeof bot === "object" && bot !== null && !Array.isArray(bot)
    ? (readPackage(bot as Record<string, unknown>).recipe?.contracts ?? [])
    : [];

/** What `next`'s contracts break for callers of `previous` (both `bot.json` values). */
export function contractBreaks(previous: unknown, next: unknown): string[] {
  return breakingChanges(contractsOf(previous), contractsOf(next));
}

/** A package's `bot.json` among its files; undefined when it has none or it doesn't read. */
export function botJsonOf(files: readonly ArchiveFile[]): unknown {
  const file = files.find((each) => each.path === "bot.json");
  if (!file) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(file.content));
  } catch {
    return undefined;
  }
}

/** The sentence a refusal gives for `breaks` against `version`. */
export function breaksReason(version: string, breaks: readonly string[]): string {
  return `Its contracts would break bots that call ${version}: ${breaks.join("; ")}. A breaking change takes a new contract name.`;
}
