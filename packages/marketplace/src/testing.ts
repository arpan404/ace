import type {
  MarketEntryType,
  MarketKeySet,
  MarketPublisher,
  Signed,
} from "@ace/protocol/marketplace";
import {
  signRegistryKeyAttestation,
  type GrantSigningKey,
  policyBodySha256,
} from "@ace/account-grant";
import { writeArchive, type ArchiveFile } from "./archive.ts";
import { signRegistryKey } from "./registry.ts";
import { contentHash, hashFiles } from "./hash.ts";
import {
  marketPublicKey,
  signManifest,
  signReviewMark,
  signWithdrawn,
  type MarketSigningKey,
} from "./signing.ts";

/*
 * Fixtures for tests of the market, the signer and the daemon's client: folders, signed
 * versions and keys, built with the same code the real signer uses.
 */

/** A signing key from a fixed byte, so a test's key is the same every run. */
export function testKey(id = "test", fill = 7): MarketSigningKey {
  return { id, privateKey: new Uint8Array(32).fill(fill) };
}
export const keySetOf = (...keys: MarketSigningKey[]): MarketKeySet => ({
  keys: keys.map(marketPublicKey),
});

const encoder = new TextEncoder();
/** Files from text; a path ending in `*` is executable (the star is dropped). */
export function folder(files: Record<string, string | Uint8Array>): ArchiveFile[] {
  return Object.entries(files).map(([path, content]) => ({
    path: path.endsWith("*") ? path.slice(0, -1) : path,
    executable: path.endsWith("*"),
    content: typeof content === "string" ? encoder.encode(content) : content,
  }));
}

export const testPublisher: MarketPublisher = { id: "pub_test", name: "tester" };

export function sampleSuit(id = "harbour-dusk"): ArchiveFile[] {
  return folder({
    "suit.json": JSON.stringify({
      format: 1,
      id,
      name: "Harbour dusk",
      description: "Slate panels and a warm lamp.",
      version: "1",
      base: "ace",
      light: {},
      dark: {},
    }),
    "market.json": JSON.stringify({
      line: "Slate panels and a warm lamp.",
      categories: ["calm"],
      keywords: ["slate"],
    }),
  });
}

export function sampleSkill(
  name = "triage-mail",
  extra: Record<string, string> = {},
): ArchiveFile[] {
  return folder({
    "SKILL.md": `---\nname: ${name}\ndescription: Sorts a mail inbox into what needs a reply today.\n---\n# Triage mail\n\nRead the newest mail first.\n`,
    ...extra,
  });
}

export function samplePlugin(name = "mail-tools"): ArchiveFile[] {
  return folder({
    "ace-plugin.json": JSON.stringify({
      schemaVersion: 1,
      name,
      version: "1.0.0",
      description: "Mail helpers.",
      skills: [{ name: "draft", path: "skills/draft" }],
      mcpServers: {
        mail: { type: "stdio", command: "${PLUGIN_ROOT}/bin/mail", args: ["--serve"] },
      },
      hooks: [{ event: "PreToolUse", command: "${PLUGIN_ROOT}/bin/guard" }],
    }),
    "skills/draft/SKILL.md": "---\nname: draft\ndescription: Drafts a reply.\n---\nDraft it.\n",
    "bin/mail*": "#!/bin/sh\necho mail\n",
    "bin/guard*": "#!/bin/sh\nexit 0\n",
  });
}

/** A version 3 agent package (ADR 0200): Flight watcher at `version`, its manifest changed by `manifest`. */
export function samplePackage(manifest: Record<string, unknown> = {}): ArchiveFile[] {
  return folder({
    "bot.json": JSON.stringify({
      format: "spade-bot",
      version: 3,
      requires: { runtime: "1" },
      name: "Flight watcher",
      blurb: "Watches fares and tells you when one drops.",
      task: "You watch flight fares for the person.",
      model: "fast",
      triggers: [
        { kind: "message" },
        {
          kind: "schedule",
          name: "Morning check",
          instruction: "Check every watched trip.",
          schedule: "daily at 7:00",
        },
      ],
      effects: [
        { effect: "network", hosts: ["api.example-fares.com"], why: "Reads fares." },
        { effect: "send_as_person", why: "Drafts a mail to your travel agent. You send it." },
      ],
      limits: { spend_alert: { usd_per_day: 0.5 } },
      notes: ["The person books."],
      pricing: { kind: "free" },
      ...manifest,
    }),
    "README.md": "# Flight watcher\n\nWatches fares.",
  });
}

export function sampleRecipe(
  recipe: Record<string, unknown> = {},
  extra: Record<string, string> = {},
): ArchiveFile[] {
  return folder({
    "bot.json": JSON.stringify({
      format: "spade-bot",
      version: 2,
      name: "Inbox",
      blurb: "Sorts your mail each morning.",
      task: "You look after the person's inbox.",
      face: { kind: "character", body: "fox", pair: "ember" },
      model: "fast",
      routines: [
        { name: "Morning sort", instruction: "Sort the inbox.", schedule: "weekdays at 8:00" },
      ],
      skills: ["spade-skill/triage-mail"],
      plugins: ["spade-plugin/mail-tools"],
      needs: {
        connectors: [
          { id: "gmail", why: "Reads and drafts mail.", required: true },
          { url: "https://mcp.example.com/mcp", why: "Files receipts.", required: false },
        ],
      },
      notes: ["Never send a reply without the person's word."],
      ...recipe,
    }),
    ...extra,
  });
}

export interface SignedVersion {
  type: MarketEntryType;
  name: string;
  version: string;
  archive: Uint8Array;
  hash: string;
  manifest: Signed;
  review?: Signed | undefined;
}

/** A version as the signer would leave it: archive, signed manifest and, if asked, a review mark. */
export function signedVersion(input: {
  type: MarketEntryType;
  name: string;
  version?: string;
  files: ArchiveFile[];
  key?: MarketSigningKey;
  reviewed?: boolean;
  byAce?: boolean;
  published?: number;
  /** Signed for this organization's registry (ADR 0206 §5.2). */
  registry?: string;
}): SignedVersion {
  const key = input.key ?? testKey();
  const hashed = hashFiles(input.files);
  const hash = contentHash(hashed);
  const version = input.version ?? "1.0.0";
  const manifest = signManifest(
    {
      format: "ace-market-manifest",
      type: input.type,
      name: input.name,
      version,
      publisher: testPublisher,
      hash,
      files: hashed,
      size: hashed.reduce((sum, file) => sum + file.bytes, 0),
      published: input.published ?? 1_700_000_000_000,
      key: key.id,
      ...(input.registry ? { registry: input.registry } : {}),
    },
    key,
  );
  const review =
    input.reviewed === undefined
      ? undefined
      : signReviewMark(
          {
            format: "ace-market-review",
            type: input.type,
            name: input.name,
            hash,
            reviewed: input.reviewed,
            byAce: input.byAce ?? false,
            at: input.published ?? 1_700_000_000_000,
            key: key.id,
          },
          key,
        );
  return {
    type: input.type,
    name: input.name,
    version,
    archive: writeArchive(input.files),
    hash,
    manifest,
    review,
  };
}

/**
 * A signed withdrawn list. An entry naming its type, name and version is a publisher's
 * withdrawal of that version; one naming only a hash is a maintainer's revocation.
 */
export function signedWithdrawn(
  withdrawn: {
    hash: string;
    reason: string;
    type?: MarketEntryType;
    name?: string;
    version?: string;
  }[],
  options: { key?: MarketSigningKey; issued?: number } = {},
): Signed {
  const key = options.key ?? testKey();
  const issued = options.issued ?? 1_700_000_000_000;
  return signWithdrawn(
    {
      format: "ace-market-withdrawn",
      issued,
      withdrawn: withdrawn.map((entry) =>
        entry.type && entry.name && entry.version
          ? {
              scope: "version" as const,
              type: entry.type,
              name: entry.name,
              version: entry.version,
              hash: entry.hash,
              reason: entry.reason,
              at: issued,
            }
          : { scope: "hash" as const, hash: entry.hash, reason: entry.reason, at: issued },
      ),
      key: key.id,
    },
    key,
  );
}

/**
 * A registry key as an owner sends it and the market serves it (ADR 0206 §5.3): the upload,
 * signed by the key and, after the first, by `previous`, with the account backend's attestation
 * of it, signed by `grantKey`.
 */
export function registryLink(input: {
  org: string;
  position: number;
  key: MarketSigningKey;
  previous?: MarketSigningKey;
  owner: string;
  at: number;
  grantKey: GrantSigningKey;
  /** The owner's role as the attestation names it; `owner` unless a test says otherwise. */
  role?: string;
}): { upload: string; attestation: string } {
  const own = marketPublicKey(input.key);
  const upload = JSON.stringify(
    signRegistryKey(
      {
        format: "ace-registry-key",
        org: input.org,
        position: input.position,
        key: own.id,
        publicKey: own.publicKey,
        ...(input.previous ? { previous: input.previous.id } : {}),
        addedBy: input.owner,
        at: input.at,
      },
      input.key,
      input.previous,
    ),
  );
  const attestation = signRegistryKeyAttestation(
    {
      org: input.org,
      upload_sha256: policyBodySha256(upload),
      account: input.owner,
      role: input.role ?? "owner",
      at: input.at,
    },
    input.grantKey,
  );
  return { upload, attestation };
}
