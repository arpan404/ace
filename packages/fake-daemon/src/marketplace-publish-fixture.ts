import type {
  MarketEntrySummary,
  MarketOwnEntry,
  MarketOwnVersion,
  MarketProfile,
  MarketScanReport,
} from "@ace/protocol/marketplace";
import { report } from "@ace/marketplace/scan";
import { passedScan, type MarketPublishSeed } from "./marketplace-publish.ts";

/*
 * A publisher's world for building the publishing and Discover UI against the fake daemon:
 * a verified profile; entries live, held, blocked, withdrawn and deprecated; drafts scanning and
 * done with a warning; a draft whose publish is held and one that is blocked; an incoming
 * transfer, signals, verification, Discover and two publisher pages.
 */

const hash = (digit: string) => digit.repeat(64);
const day = 86_400_000;

const blockedScan: MarketScanReport = report(
  [
    {
      check: "scripts",
      rule: "download-exec",
      level: "block",
      path: "scripts/setup.sh",
      line: 4,
      message: "scripts/setup.sh line 4 downloads a script and runs it.",
    },
  ],
  { files: 3, textBytes: 1800 },
  hash("b"),
);
const warnScan: MarketScanReport = report(
  [
    {
      check: "plugin",
      rule: "undeclared-host",
      level: "warn",
      path: "server.js",
      line: 12,
      message: "server.js talks to api.example.com, which the manifest doesn't declare.",
    },
  ],
  { files: 5, textBytes: 4200 },
  hash("c"),
);

const version = (
  v: string,
  status: MarketOwnVersion["status"],
  extra: Partial<MarketOwnVersion> = {},
): MarketOwnVersion => ({
  version: v,
  hash: hash(v.replaceAll(".", "").slice(0, 1) || "0"),
  size: 4096,
  published: 1_700_000_000_000,
  status,
  held: false,
  changelog: `What changed in ${v}.`,
  downloads: status === "live" ? 240 : 0,
  ...extra,
});

const own = (
  type: MarketOwnEntry["summary"]["type"],
  name: string,
  title: string,
  versions: MarketOwnVersion[],
  extra: Partial<MarketOwnEntry["summary"]> = {},
): MarketOwnEntry => ({
  summary: {
    type,
    name,
    title,
    line: `${title} in one line.`,
    version: versions[0]?.version,
    status: versions[0]?.status,
    versions: versions.length,
    visibility: "listed",
    archived: false,
    pinned: false,
    reviewed: versions.some((item) => item.status === "live"),
    downloads: versions.reduce((sum, item) => sum + item.downloads, 0),
    pendingListing: false,
    openReports: 0,
    ...extra,
  },
  listing: {
    title,
    line: `${title} in one line.`,
    description: `${title}, described.`,
    categories: ["mail"],
    keywords: [],
    links: [],
    previews: [],
  },
  versions,
});

const profile: MarketProfile = {
  id: "pub_harbour",
  handle: "harbour",
  displayName: "Harbour Studio",
  bio: "Calm Suits and careful mail skills.",
  links: [{ label: "Site", url: "https://harbour.example" }],
  joined: 1_690_000_000_000,
  verified: true,
  proofs: [{ kind: "account" }, { kind: "domain", domain: "harbour.example", via: "dns" }],
  pins: [{ type: "suit", name: "harbour-dusk" }],
};

const summary = (
  type: string,
  name: string,
  title: string,
  extra: Partial<MarketEntrySummary> = {},
) =>
  ({
    source: "market",
    type,
    name,
    title,
    line: `${title} in one line.`,
    publisher: { id: "pub_harbour", name: "harbour" },
    categories: ["mail"],
    keywords: [],
    version: "1.2.0",
    reviewed: true,
    byAce: false,
    updated: 1_700_000_000_000,
    downloads: 240,
    supported: true,
    verified: true,
    ...extra,
  }) satisfies MarketEntrySummary;

/** The fixture as a `MarketplaceSeed.publishing`; `signedOut` shows the signed-out page. */
export function marketPublishFixture(options: { signedOut?: boolean } = {}): MarketPublishSeed {
  const entries = [
    own(
      "suit",
      "harbour-dusk",
      "Harbour dusk",
      [
        version("1.2.0", "live"),
        version("1.1.0", "live", { deprecated: "Use 1.2.0; 1.1 has a contrast bug." }),
      ],
      { pinned: true },
    ),
    own("spade-plugin", "mail-tools", "Mail tools", [
      version("2.0.0", "waiting", { held: true, scan: warnScan }),
      version("1.0.0", "live"),
    ]),
    own("spade-skill", "setup-mail", "Setup mail", [
      version("1.0.0", "blocked", {
        reason: "The scan refused it: it downloads a script and runs it.",
        scan: blockedScan,
        appeal: { id: "apl_fake0001", note: "The script is ours.", at: 1, state: "open" },
      }),
    ]),
    own(
      "spade-skill",
      "old-sorter",
      "Old sorter",
      [version("0.3.0", "withdrawn", { reason: "Replaced by triage-mail." })],
      { archived: true, visibility: "unlisted" },
    ),
  ];
  return {
    signedOut: options.signedOut ?? false,
    me: {
      profile,
      state: "active",
      newPublisher: false,
      limits: {
        uploadsToday: 2,
        uploadsPerDay: 30,
        storedBytes: 40 * 1024 * 1024,
        quotaBytes: 1024 * 1024 * 1024,
        drafts: 2,
        draftLimit: 20,
      },
      entries: entries.map((entry) => entry.summary),
      drafts: [
        {
          id: "drf_scanning1",
          type: "spade-skill",
          name: "triage-mail",
          version: "1.3.0",
          hash: hash("d"),
          size: 3000,
          files: 4,
          created: 1_700_000_000_000,
          updated: 1_700_000_000_000,
          changelog: "Sorts newsletters apart.",
          title: "Triage mail",
          problems: [],
          scan: { state: "scanning", read: 1, files: 4 },
        },
        {
          id: "drf_heldnext",
          type: "spade-plugin",
          name: "mail-tools",
          version: "2.1.0",
          hash: hash("e"),
          size: 9000,
          files: 5,
          created: 1_700_000_000_000,
          updated: 1_700_000_000_000,
          changelog: "",
          title: "Mail tools",
          problems: [],
          scan: { state: "done", report: warnScan },
        },
        {
          id: "drf_blockednext",
          type: "spade-skill",
          name: "setup-mail",
          version: "1.0.1",
          hash: hash("f"),
          size: 1200,
          files: 3,
          created: 1_700_000_000_000,
          updated: 1_700_000_000_000,
          changelog: "",
          title: "Setup mail",
          problems: [],
          scan: { state: "done", report: passedScan(hash("f"), 3) },
        },
      ],
      transfers: [
        {
          id: "trf_incoming1",
          type: "suit",
          name: "night-ferry",
          from: "lighthouse",
          to: "harbour",
          at: 1_700_000_000_000,
          expiresAt: 1_700_000_000_000 + 7 * day,
          direction: "incoming",
        },
      ],
    },
    entries,
    signals: {
      "suit/harbour-dusk": {
        days: [19_670, 19_671, 19_672],
        versions: [
          { version: "1.2.0", downloads: [10, 14, 22] },
          { version: "1.1.0", downloads: [6, 3, 1] },
        ],
        adoption: { latest: "1.2.0", share: 0.8, downloads: 56 },
        reports: [{ reason: "spam", state: "dismissed", at: 1_700_000_000_000 }],
      },
    },
    verification: {
      verified: true,
      proofs: profile.proofs,
      state: "verified",
      challenges: [],
    },
    publishing: { drf_heldnext: "held", drf_blockednext: { blocked: blockedScan } },
    discover: {
      hero: summary("suit", "harbour-dusk", "Harbour dusk"),
      featured: [summary("suit", "harbour-dusk", "Harbour dusk")],
      trending: [
        {
          entry: summary("spade-skill", "triage-mail", "Triage mail", {
            publisher: { id: "pub_ace", name: "ace" },
            byAce: true,
            verified: false,
          }),
          rank: 1,
          movement: { kind: "up", by: 3 },
          week: 410,
        },
        {
          entry: summary("suit", "harbour-dusk", "Harbour dusk"),
          rank: 2,
          movement: { kind: "new" },
          week: 240,
        },
      ],
      fresh: [summary("spade-plugin", "mail-tools", "Mail tools", { version: "1.0.0" })],
      collections: [
        {
          id: "calm-desk",
          title: "A calm desk",
          line: "Quiet Suits for long days.",
          entries: [summary("suit", "harbour-dusk", "Harbour dusk")],
        },
      ],
      publishers: [
        {
          handle: "harbour",
          displayName: "Harbour Studio",
          verified: true,
          entries: 3,
          downloads: 480,
        },
        {
          handle: "lighthouse",
          displayName: "Lighthouse",
          verified: false,
          entries: 1,
          downloads: 60,
        },
      ],
      rankedAt: 1_700_000_000_000,
    },
    publishers: [
      {
        profile,
        pinned: [summary("suit", "harbour-dusk", "Harbour dusk")],
        entries: [
          summary("suit", "harbour-dusk", "Harbour dusk"),
          summary("spade-plugin", "mail-tools", "Mail tools", { version: "1.0.0" }),
        ],
        downloads: 480,
      },
      {
        profile: {
          ...profile,
          id: "pub_lighthouse",
          handle: "lighthouse",
          displayName: "Lighthouse",
          verified: false,
          proofs: [],
          pins: [],
          links: [],
        },
        pinned: [],
        entries: [summary("suit", "night-ferry", "Night ferry", { verified: false })],
        downloads: 60,
      },
    ],
  };
}
