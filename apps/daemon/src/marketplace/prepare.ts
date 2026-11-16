import {
  installableMarketTypes,
  MarketEntryType,
  type MarketProblem,
  type MarketPublisher,
  type MarketScanReport,
} from "@ace/protocol/marketplace";
import type { PluginReview } from "@ace/protocol/plugins";
import {
  hashFiles,
  manifestMismatch,
  readArchive,
  readFeedEntry,
  SignatureError,
  typeLimits,
  verifyManifest,
  verifyReviewMark,
  recipeEntries,
  type ArchiveFile,
  type WithdrawalTarget,
} from "@ace/marketplace";
import { EntryBody, VersionBody, type MarketKeySet } from "@ace/protocol/marketplace";
import { checkFiles } from "@ace/marketplace/checks";
import { scanEntry, type ScanContext } from "@ace/marketplace/scan";
import type { GitCatalogs } from "./git.ts";
import type { MarketHttp } from "./http.ts";
import type { PreparedEntry } from "./review.ts";
import type { MarketStore, StoredSource } from "./store.ts";
import type { Badges } from "./trust.ts";

/*
 * Fetching one version for review (ADR 0168 §6, §8). Everything the device decides, it decides
 * itself: the manifest's signature against the keys this build ships, the archive against the
 * manifest, the withdrawn list, the type's checks again on the bytes, then ADR 0173's scan of
 * those exact bytes, whose block refuses whatever the market said. Nothing in the entry
 * runs: bytes are read into memory and checked, never executed.
 */

export class Refused extends Error {
  override name = "Refused";
  readonly problems: MarketProblem[];
  readonly code: "refused" | "not_found" | "unavailable" | "blocked";
  /** The device's scan, when it is what refused (`blocked`). */
  readonly scan: MarketScanReport | undefined;
  constructor(
    message: string,
    options: { problems?: MarketProblem[]; code?: Refused["code"]; scan?: MarketScanReport } = {},
  ) {
    super(message);
    this.problems = options.problems ?? [];
    this.code = options.code ?? "refused";
    this.scan = options.scan;
  }
}

export interface PreparePorts {
  http: MarketHttp | undefined;
  git: GitCatalogs;
  keys: MarketKeySet;
  /** Why a version of this source is withdrawn, from every verified list, if it is. */
  withdrawal: (target: WithdrawalTarget) => string | undefined;
  /** ADR 0014's review of a plugin from these bytes. */
  preparePlugin: (input: PluginFilesInput) => Promise<PluginReview>;
  /** Who the signed lists this device verified mark as verified or official. */
  badges: Badges;
  /** What the scan compares against: the local index, the verified list, the blocklist. */
  scanContext: (publisher: MarketPublisher | undefined) => ScanContext;
}

/** What ADR 0014's manager needs to review a plugin from bytes the marketplace verified. */
export interface PluginFilesInput {
  name: string;
  hash: string;
  commit: string;
  origin: { repository: string; ref: string };
  files: readonly ArchiveFile[];
}

const parseVersion = (value: string) => {
  const [core = "", pre] = value.split("-", 2);
  return { parts: core.split(".").map(Number), pre };
};
const versionOrder = (a: string, b: string): number => {
  const parse = parseVersion;
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
};
/** Whether `candidate` is a newer version than `installed`. */
export const newer = (candidate: string, installed: string) =>
  versionOrder(candidate, installed) > 0;

export async function prepareEntry(
  ports: PreparePorts,
  source: StoredSource,
  type: string,
  name: string,
  version: string | undefined,
): Promise<PreparedEntry> {
  const known = MarketEntryType.safeParse(type);
  if (!known.success || !installableMarketTypes.includes(known.data))
    throw new Refused("This entry needs a newer ace.");
  const entryType = known.data;
  const fetched =
    source.kind === "market"
      ? await fromMarket(ports, entryType, name, version)
      : await fromGit(ports, source, entryType, name);
  const checked = checkFiles(entryType, name, fetched.files);
  // A Suit that fails is still reviewed, so the person sees why; it can't be installed.
  if (checked.problems.length > 0 && entryType !== "suit")
    throw new Refused(`${name} doesn't pass ace's checks`, { problems: checked.problems });
  if (checked.hash !== fetched.hash)
    throw new Refused("The files don't match the hash they were offered under");
  // ADR 0173 §8: the device scans the exact bytes it verified, and refuses a block even when
  // the market listed and signed them. Warns and notes go to the review.
  const scan = scanEntry({
    type: entryType,
    name,
    files: checked.files,
    listing: checked.listing,
    inspection: checked.inspection,
    context: ports.scanContext(fetched.publisher),
  });
  if (scan.verdict === "block")
    throw new Refused(
      `${type}/${name} ${fetched.version} was refused by ace's scan on this device`,
      {
        code: "blocked",
        scan,
      },
    );
  const pluginInput: PluginFilesInput | undefined =
    entryType === "spade-plugin"
      ? {
          name,
          hash: checked.hash,
          commit: fetched.commit,
          origin: fetched.origin,
          files: checked.files,
        }
      : undefined;
  const plugin = pluginInput ? await ports.preparePlugin(pluginInput) : undefined;
  return {
    source: source.id,
    type: entryType,
    name,
    title: fetched.title ?? checked.listing.title,
    version: fetched.version,
    hash: checked.hash,
    publisher: fetched.publisher,
    from: source.kind === "git" ? source.address : undefined,
    signed: fetched.signed,
    reviewed: fetched.reviewed,
    byAce: fetched.byAce,
    checked,
    plugin,
    pluginInput,
    scan,
    ...(fetched.deprecated ? { deprecated: fetched.deprecated } : {}),
    ...(fetched.unlisted ? { unlisted: true } : {}),
  };
}

interface Fetched {
  files: ArchiveFile[];
  hash: string;
  version: string;
  title: string | undefined;
  publisher: MarketPublisher | undefined;
  signed: boolean;
  reviewed: boolean;
  byAce: boolean;
  /** The plugin manager's pin: a git commit, or the hash's first 40 digits for the market. */
  commit: string;
  origin: { repository: string; ref: string };
  deprecated?: string | undefined;
  unlisted?: boolean | undefined;
}

async function fromMarket(
  ports: PreparePorts,
  type: MarketEntryType,
  name: string,
  wanted: string | undefined,
): Promise<Fetched> {
  const http = ports.http;
  if (!http) throw new Refused("market.acehq.dev is turned off", { code: "unavailable" });
  const page = EntryBody.safeParse(await http.entry(type, name));
  if (!page.success) throw new Refused("The market's entry page isn't in a form this build reads");
  const summary = readFeedEntry(page.data.entry);
  const withdrawn = (item: { version: string; hash: string }) =>
    ports.withdrawal({ type, name, version: item.version, hash: item.hash });
  const version =
    wanted ??
    page.data.versions
      .filter((item) => !item.withdrawn && !withdrawn(item))
      .toSorted((a, b) => versionOrder(b.version, a.version))[0]?.version;
  if (!version) throw new Refused(`${name} has no version to install`, { code: "not_found" });
  const body = VersionBody.safeParse(await http.version(type, name, version));
  if (!body.success)
    throw new Refused("The market's version page isn't in a form this build reads");
  let manifest;
  try {
    manifest = verifyManifest(body.data.manifest, ports.keys);
  } catch (error) {
    if (error instanceof SignatureError)
      throw new Refused(`Not signed by ace's market: ${error.message}`);
    throw error;
  }
  if (manifest.type !== type || manifest.name !== name || manifest.version !== version)
    throw new Refused("The signed manifest names another version");
  const reason = withdrawn({ version, hash: manifest.hash });
  if (reason) throw new Refused(`This version was withdrawn: ${reason}`);
  let reviewed = false;
  if (body.data.review) {
    let mark;
    try {
      mark = verifyReviewMark(body.data.review, ports.keys);
    } catch (error) {
      if (error instanceof SignatureError)
        throw new Refused(`The review mark isn't ace's: ${error.message}`);
      throw error;
    }
    if (mark.hash !== manifest.hash || mark.type !== type || mark.name !== name)
      throw new Refused("The review mark is for other bytes");
    reviewed = mark.reviewed;
  }
  // "By ace" only for the official list's publisher (ADR 0173 §14); the mark's flag is display.
  const byAce = ports.badges.official(manifest.publisher.id);
  let files: ArchiveFile[];
  try {
    files = readArchive(await http.object(manifest.hash), typeLimits[type]);
  } catch (error) {
    throw new Refused(error instanceof Error ? error.message : "The archive doesn't read");
  }
  const mismatch = manifestMismatch(manifest, hashFiles(files));
  if (mismatch) throw new Refused(`${mismatch}; nothing was installed`);
  return {
    files,
    hash: manifest.hash,
    version,
    title: "problem" in summary ? undefined : summary.title,
    publisher: manifest.publisher,
    signed: true,
    reviewed,
    byAce,
    commit: manifest.hash.slice(0, 40),
    origin: { repository: `${http.origin}/v1/entries/${type}/${name}`, ref: version },
    deprecated: page.data.versions.find((item) => item.version === version)?.deprecated,
    unlisted: page.data.unlisted,
  };
}

async function fromGit(
  ports: PreparePorts,
  source: StoredSource,
  type: MarketEntryType,
  name: string,
): Promise<Fetched> {
  const read = await ports.git.entry(source.address, type, name);
  const entry = read.catalog.entries.find((item) => item.type === type && item.name === name);
  return {
    files: read.files,
    hash: read.hash,
    version: entry?.version ?? read.commit.slice(0, 12),
    title: entry?.title,
    publisher: undefined,
    signed: false,
    reviewed: false,
    byAce: false,
    commit: read.commit,
    origin: { repository: source.address, ref: "HEAD" },
  };
}

/**
 * An entry with what an update would replace and, for a recipe, every skill and plugin it brings
 * from the same source, each prepared and checked as itself.
 */
export async function prepareWithBrings(
  ports: PreparePorts,
  store: MarketStore,
  source: StoredSource,
  type: string,
  name: string,
  version: string | undefined,
): Promise<{ entry: PreparedEntry; brings: PreparedEntry[] }> {
  const withPrevious = async (entry: PreparedEntry): Promise<PreparedEntry> => {
    const current = store.install(entry.type, entry.name);
    if (!current || current.hash === entry.hash || entry.type === "spade-bot") return entry;
    const files: ArchiveFile[] = await store.pinned(current.hash, current.type).catch(() => []);
    return { ...entry, previous: { version: current.version, files } };
  };
  const entry = await withPrevious(await prepareEntry(ports, source, type, name, version));
  const brings: PreparedEntry[] = [];
  if (entry.checked.inspection?.type === "spade-bot")
    for (const brought of recipeEntries(entry.checked.inspection.recipe)) {
      const prepared = await prepareEntry(
        ports,
        source,
        brought.type,
        brought.name,
        undefined,
      ).catch((thrown: unknown) => {
        if (thrown instanceof Refused)
          throw new Refused(`${brought.type}/${brought.name}: ${thrown.message}`, {
            problems: thrown.problems,
            code: thrown.code === "blocked" ? "blocked" : "refused",
            ...(thrown.scan ? { scan: thrown.scan } : {}),
          });
        throw thrown;
      });
      brings.push(await withPrevious(prepared));
    }
  return { entry, brings };
}
