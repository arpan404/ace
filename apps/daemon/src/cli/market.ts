import { lstat, opendir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { decodeBase64url, encodeBase64url } from "@ace/account-grant";
import {
  MarketEntryName,
  MarketEntryType,
  MarketQueueBody,
  MarketReportsBody,
  MarketDiscoverBody,
  MarketReportState,
  type MarketCollection,
} from "@ace/protocol/marketplace";
import {
  marketOrigin,
  marketPublicKey,
  shippedMarketKeys,
  marketSigningKey,
  type ArchiveFile,
  type MarketSigningKey,
} from "@ace/marketplace";
import { type MarketKeySet } from "@ace/protocol/marketplace";
import { checkFiles } from "@ace/marketplace/checks";
import {
  findingSentence,
  signBlocklistChange,
  signOfficialChange,
  signPending,
  signReview,
  signRevocation,
  signVerifiedChange,
  signWithdrawAll,
  type BlocklistChange,
  type SignerIo,
} from "@ace/marketplace/signer";
import { option, validateArgs, type Args } from "./args.ts";
import { print } from "./io.ts";
import { CliFailure } from "./output.ts";

/*
 * The marketplace's maintainer tools (ADR 0168 §6, §7), run on a maintainer's machine:
 *
 *   ace market keygen KEY_FILE [--id ID]          a signing key in a file; prints its public half
 *   ace market sign --key KEY_FILE [--url URL]    re-scan, then sign, hold or block what waits;
 *                                                 sign any pending withdrawals
 *   ace market review                             what waits for a maintainer, as sentences
 *   ace market review TYPE/NAME@VERSION --show|--approve|--block REASON
 *   ace market review TYPE/NAME@VERSION --key KEY_FILE [--by-ace] [--not-reviewed]
 *                                                 sign the review mark
 *   ace market feature TYPE/NAME ... [--url URL]  the featured list (reviewed entries only)
 *   ace market revoke HASH --reason TEXT --key KEY_FILE
 *                                                 withdraw bytes wherever they are listed
 *   ace market reports [resolve ID --state STATE [--note TEXT]]
 *   ace market collection list|put ID --title T --line L TYPE/NAME ...|remove ID
 *   ace market publisher HANDLE --suspend REASON|--restore|--withdraw-all REASON [--key KEY_FILE]
 *   ace market block HASH|block-file SHA256|block-pattern TEXT --reason TEXT --key KEY_FILE
 *   ace market appeals | appeal ID --answer TEXT --approve|--keep
 *   ace market verify|unverify HANDLE --reason TEXT --key KEY_FILE
 *   ace market official add|remove ACCOUNT --key KEY_FILE
 *   ace marketplace check PATH --type TYPE [--name NAME]   the publish checks on a folder
 *
 * The signer's token comes from ACE_MARKET_SIGNER_TOKEN; the key only ever from its file.
 */

const KeyFile = z.object({ id: z.string(), privateKey: z.string() });

async function readKey(path: string | undefined): Promise<MarketSigningKey> {
  if (!path) throw new CliFailure("refused", "Pass the signing key's file with --key");
  const info = await lstat(path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new CliFailure("refused", `${path} can be read by others; chmod 600 it first`);
  const file = KeyFile.parse(JSON.parse(await readFile(path, "utf8")));
  return marketSigningKey(file.id, decodeBase64url(file.privateKey));
}

function marketUrl(args: Args): URL {
  const url = new URL(option(args, "url") ?? marketOrigin);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    throw new CliFailure("refused", "The market is reached over https only");
  return url;
}

async function answered(response: Response): Promise<Response> {
  if (!response.ok)
    throw new CliFailure(
      "failed",
      `The market answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  return response;
}

function signerIo(base: URL): SignerIo {
  const token = process.env["ACE_MARKET_SIGNER_TOKEN"];
  if (!token)
    throw new CliFailure("refused", "Set ACE_MARKET_SIGNER_TOKEN to the market's signer token");
  const headers = { authorization: `Bearer ${token}` };
  return {
    get: async (path) => (await answered(await fetch(new URL(path, base), { headers }))).json(),
    object: async (hash) =>
      new Uint8Array(
        await (
          await answered(await fetch(new URL(`/v1/signer/objects/${hash}`, base), { headers }))
        ).arrayBuffer(),
      ),
    put: async (path, body) => {
      const response = await fetch(new URL(path, base), {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: (await response.text()).slice(0, 2000) };
    },
  };
}

/** A folder's regular files, as an archive would hold them; links and other kinds refused. */
async function readFolder(root: string): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  const walk = async (folder: string, depth: number) => {
    if (depth > 32) throw new CliFailure("refused", `${folder} is nested too deep`);
    for await (const entry of await opendir(folder)) {
      const path = join(folder, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink())
        throw new CliFailure("refused", `${name} is a link; an entry holds only its own files`);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) {
        const info = await lstat(path);
        files.push({
          path: name,
          executable: (info.mode & 0o111) !== 0,
          content: new Uint8Array(await readFile(path)),
        });
      } else throw new CliFailure("refused", `${name} isn't a regular file`);
    }
  };
  await walk(root, 0);
  return files;
}

const now = () => Date.now();

/**
 * The keys a read-back signature may be by: the ones this build ships and the key signing now,
 * so a list or manifest the previous key signed still verifies after a rotation.
 */
function trustedWith(key: MarketSigningKey): MarketKeySet {
  const active = marketPublicKey(key);
  return {
    keys: [...shippedMarketKeys.keys.filter((known) => known.id !== active.id), active],
  };
}

export async function marketCommand(args: Args): Promise<void> {
  const verb = args.words[1];
  switch (verb) {
    case "keygen": {
      validateArgs(args, ["id"], 3, 3);
      const path = args.words[2] ?? "";
      const key = marketSigningKey(
        option(args, "id") ?? "market-1",
        crypto.getRandomValues(new Uint8Array(32)),
      );
      await writeFile(
        path,
        JSON.stringify({ id: key.id, privateKey: encodeBase64url(key.privateKey) }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      return print(args, { file: path, publicKey: marketPublicKey(key) });
    }
    case "sign": {
      validateArgs(args, ["key", "url"], 2, 2);
      const key = await readKey(option(args, "key"));
      const report = await signPending(signerIo(marketUrl(args)), key, now, trustedWith(key));
      await print(args, report);
      if (report.failed.length > 0)
        throw new CliFailure("failed", "Some signatures weren't taken by the market");
      return;
    }
    case "review":
      return reviewCommand(args);
    case "feature": {
      validateArgs(args, ["url"], 2, 26);
      const entries = args.words.slice(2).map((word) => {
        const [type = "", name = ""] = word.split("/");
        return { type: MarketEntryType.parse(type), name: MarketEntryName.parse(name) };
      });
      const answer = await signerIo(marketUrl(args)).put("/v1/signer/featured", { entries });
      if (answer.status < 200 || answer.status >= 300)
        throw new CliFailure("failed", `The market answered ${answer.status}: ${answer.text}`);
      return print(args, { ok: true, featured: entries.length });
    }
    case "revoke": {
      validateArgs(args, ["key", "url", "reason"], 3, 3);
      const hash = args.words[2] ?? "";
      const reason = option(args, "reason");
      if (!/^[a-f0-9]{64}$/.test(hash))
        throw new CliFailure("refused", "Name the bytes by their content hash");
      if (!reason) throw new CliFailure("refused", "Say why with --reason; devices show it");
      const key = await readKey(option(args, "key"));
      const answer = await signRevocation(signerIo(marketUrl(args)), key, now, trustedWith(key), {
        hash,
        reason,
      });
      if (answer.status < 200 || answer.status >= 300)
        throw new CliFailure("failed", `The market answered ${answer.status}: ${answer.text}`);
      return print(args, { ok: true, revoked: hash });
    }
    default:
      return maintainerCommand(verb, args);
  }
}

/** `ace marketplace check PATH --type TYPE [--name NAME]`: the checks the market runs on upload. */
export async function marketplaceCommand(args: Args): Promise<void> {
  if (args.words[1] !== "check")
    throw new CliFailure("refused", "Use ace marketplace check PATH --type TYPE");
  validateArgs(args, ["type", "name"], 3, 3);
  const root = args.words[2] ?? "";
  const type = MarketEntryType.safeParse(option(args, "type"));
  if (!type.success)
    throw new CliFailure("refused", "Pass --type suit, spade-skill, spade-plugin or spade-bot");
  const name = option(args, "name") ?? root.split(/[\\/]/).findLast(Boolean) ?? "";
  if (!MarketEntryName.safeParse(name).success)
    throw new CliFailure("refused", `${name} isn't an entry name; pass --name`);
  const checked = checkFiles(type.data, name, await readFolder(root));
  const result = {
    type: type.data,
    name,
    hash: checked.hash,
    files: checked.files.length,
    bytes: checked.size,
    listing: checked.listing,
    problems: checked.problems,
  };
  if (checked.problems.length === 0)
    return print(
      args,
      args.flags.json ? result : `${type.data}/${name} passes. Content hash ${checked.hash}.`,
    );
  await print(
    args,
    args.flags.json
      ? result
      : checked.problems
          .map(
            (problem) =>
              `${problem.path ?? name}${problem.line ? `:${problem.line}` : ""}: ${problem.message}`,
          )
          .join("\n"),
  );
  throw new CliFailure(
    "refused",
    `${checked.problems.length} problem${checked.problems.length === 1 ? "" : "s"}`,
  );
}

/* ---------------------------------------------------------------- the maintainers' work */

const succeeded = (answer: { status: number; text: string }) => {
  if (answer.status < 200 || answer.status >= 300)
    throw new CliFailure("failed", `The market answered ${answer.status}: ${answer.text}`);
};
const pathOf = (key: { type: string; name: string; version?: string }) =>
  [key.type, key.name, ...(key.version ? [key.version] : [])].map(encodeURIComponent).join("/");

function versionTarget(word: string | undefined) {
  const match = /^([a-z-]+)\/([^@]+)@(.+)$/.exec(word ?? "");
  if (!match) throw new CliFailure("refused", "Name the version as TYPE/NAME@VERSION");
  return {
    type: MarketEntryType.parse(match[1]),
    name: MarketEntryName.parse(match[2]),
    version: match[3] ?? "",
  };
}
function entryTarget(word: string) {
  const [type = "", name = ""] = word.split("/");
  return { type: MarketEntryType.parse(type), name: MarketEntryName.parse(name) };
}
const needed = (args: Args, name: string, what: string) => {
  const value = option(args, name);
  if (!value) throw new CliFailure("refused", what);
  return value;
};

type Queue = MarketQueueBody;
/** An index entry read only for its type and name. */
const EntryRef = z.object({ type: MarketEntryType, name: MarketEntryName });
const ago = (at: number) => new Date(at).toISOString().slice(0, 10);

/** What waits for a maintainer, one sentence a line. */
export function queueSentences(queue: Queue): string[] {
  const lines: string[] = [];
  for (const held of queue.held) {
    const who = `${held.publisher.name}${held.newPublisher ? ", a new publisher" : ""}`;
    lines.push(
      `Held: ${held.type}/${held.name}@${held.version} by ${who}, since ${ago(held.published)}.`,
    );
    const findings = (held.scan?.findings ?? []).filter((finding) => finding.level !== "note");
    if (findings.length === 0) lines.push("  The scan found nothing to warn about.");
    for (const finding of findings) lines.push(`  ${finding.level}: ${findingSentence(finding)}`);
  }
  for (const listing of queue.listings) {
    lines.push(
      `Listing edit: ${listing.type}/${listing.name} by ${listing.publisher.name} wants the title "${listing.listing.title}".`,
    );
    for (const finding of listing.scan.findings)
      lines.push(`  ${finding.level}: ${findingSentence(finding)}`);
  }
  for (const item of queue.verifications) {
    const proofs = item.proofs.map((proof) =>
      proof.kind === "domain"
        ? `owns ${proof.domain}`
        : proof.kind === "github"
          ? `is ${proof.login} on GitHub`
          : "has a verified ace account",
    );
    lines.push(
      item.flagged
        ? `Verification flagged: ${item.publisher.name}'s re-check failed: ${item.flagged}`
        : `Verification: ${item.publisher.name} applied; it ${proofs.join(", ")}.`,
    );
  }
  for (const appeal of queue.appeals)
    lines.push(
      `Appeal ${appeal.id}: ${appeal.publisher.name} answers the ${appeal.status === "blocked" ? "block" : "hold"} on ${appeal.type}/${appeal.name}@${appeal.version}${appeal.reason ? ` (${appeal.reason})` : ""}: "${appeal.note}"${appeal.replacement ? `, with ${appeal.replacement}` : ""}.`,
    );
  if (lines.length === 0) lines.push("Nothing waits for a maintainer.");
  return lines;
}

async function readQueue(io: SignerIo): Promise<Queue> {
  return MarketQueueBody.parse(await io.get("/v1/signer/queue"));
}

async function reviewCommand(args: Args): Promise<void> {
  validateArgs(args, ["key", "url", "by-ace", "not-reviewed", "show", "approve", "block"], 2, 3);
  const io = signerIo(marketUrl(args));
  if (args.words.length === 2) {
    const queue = await readQueue(io);
    return print(args, args.flags.json ? queue : queueSentences(queue).join("\n"));
  }
  const target = versionTarget(args.words[2]);
  if (args.flags.show === true) {
    const held = (await readQueue(io)).held.find(
      (item) =>
        item.type === target.type && item.name === target.name && item.version === target.version,
    );
    if (!held) throw new CliFailure("refused", "That version isn't held for a maintainer");
    return print(
      args,
      args.flags.json
        ? held
        : queueSentences({ held: [held], listings: [], verifications: [], appeals: [] }).join("\n"),
    );
  }
  if (args.flags.approve === true) {
    succeeded(await io.put(`/v1/signer/holds/${pathOf(target)}`, { decision: "approve" }));
    return print(
      args,
      args.flags.json ? { ok: true } : `Released ${args.words[2]}; ace market sign signs it next.`,
    );
  }
  const block = option(args, "block");
  if (block !== undefined) {
    succeeded(await io.put(`/v1/signer/blocks/${pathOf(target)}`, { reason: block }));
    return print(args, args.flags.json ? { ok: true } : `Blocked ${args.words[2]}.`);
  }
  const key = await readKey(option(args, "key"));
  succeeded(
    await signReview(io, key, now, trustedWith(key), {
      ...target,
      reviewed: args.flags["not-reviewed"] !== true,
      byAce: args.flags["by-ace"] === true,
    }),
  );
  return print(args, { ok: true });
}

async function reportsCommand(args: Args): Promise<void> {
  const io = signerIo(marketUrl(args));
  if (args.words[2] === "resolve") {
    validateArgs(args, ["url", "state", "note"], 4, 4);
    const state = MarketReportState.exclude(["open"]).safeParse(option(args, "state"));
    if (!state.success)
      throw new CliFailure("refused", "Pass --state dismissed, kept, withdrawn or blocked");
    const note = option(args, "note");
    succeeded(
      await io.put(`/v1/signer/reports/${encodeURIComponent(args.words[3] ?? "")}`, {
        state: state.data,
        ...(note ? { note } : {}),
      }),
    );
    return print(
      args,
      args.flags.json ? { ok: true } : `Report ${args.words[3]} is ${state.data}.`,
    );
  }
  validateArgs(args, ["url"], 2, 2);
  const { reports } = MarketReportsBody.parse(await io.get("/v1/signer/reports"));
  if (args.flags.json) return print(args, reports);
  const lines = reports.map(
    (report) =>
      `${report.id} (${report.state}${report.outcome ? `: ${report.outcome}` : ""}): ${report.type}/${report.name}${report.version ? `@${report.version}` : ""} reported for ${report.reason} on ${ago(report.at)}${report.note ? `: "${report.note}"` : "."}`,
  );
  return print(args, lines.length > 0 ? lines.join("\n") : "No reports.");
}

async function collectionCommand(args: Args): Promise<void> {
  const io = signerIo(marketUrl(args));
  const action = args.words[2];
  // The stored collections, as Discover shows them.
  const current = MarketDiscoverBody.parse(await io.get("/v1/discover")).collections.map(
    (collection): MarketCollection => ({
      id: collection.id,
      title: collection.title,
      line: collection.line,
      entries: collection.entries.map((entry) => EntryRef.parse(entry)),
    }),
  );
  if (action === "list") {
    validateArgs(args, ["url"], 3, 3);
    if (args.flags.json) return print(args, current);
    const lines = current.map(
      (collection) =>
        `${collection.id}: ${collection.title} (${collection.line}) holds ${collection.entries.map((entry) => `${entry.type}/${entry.name}`).join(", ") || "nothing listed"}.`,
    );
    return print(args, lines.length > 0 ? lines.join("\n") : "No collections.");
  }
  let next: MarketCollection[];
  const id = args.words[3] ?? "";
  if (action === "put") {
    validateArgs(args, ["url", "title", "line"], 5, 28);
    const collection: MarketCollection = {
      id,
      title: needed(args, "title", "Give the collection a --title"),
      line: option(args, "line") ?? "",
      entries: args.words.slice(4).map(entryTarget),
    };
    const at = current.findIndex((item) => item.id === id);
    next = at === -1 ? [...current, collection] : current.with(at, collection);
  } else if (action === "remove") {
    validateArgs(args, ["url"], 4, 4);
    if (!current.some((item) => item.id === id))
      throw new CliFailure("refused", `There's no collection ${id}`);
    next = current.filter((item) => item.id !== id);
  } else throw new CliFailure("refused", "Use ace market collection list, put or remove");
  succeeded(await io.put("/v1/signer/collections", { collections: next }));
  return print(
    args,
    args.flags.json ? { ok: true, collections: next.length } : `${next.length} collections stored.`,
  );
}

async function publisherCommand(args: Args): Promise<void> {
  validateArgs(args, ["url", "key", "suspend", "restore", "withdraw-all"], 3, 3);
  const handle = args.words[2] ?? "";
  const io = signerIo(marketUrl(args));
  const suspend = option(args, "suspend");
  const withdrawAll = option(args, "withdraw-all");
  if (withdrawAll !== undefined) {
    const key = await readKey(option(args, "key"));
    const answer = await signWithdrawAll(io, key, now, trustedWith(key), {
      handle,
      reason: withdrawAll,
    });
    succeeded(answer);
    return print(
      args,
      args.flags.json
        ? { ok: true, withdrawn: answer.added }
        : `Signed ${answer.added} withdrawals for ${handle}.`,
    );
  }
  if (suspend === undefined && args.flags.restore !== true)
    throw new CliFailure("refused", "Pass --suspend REASON, --restore or --withdraw-all REASON");
  const state = suspend !== undefined ? "suspended" : "active";
  succeeded(
    await io.put(`/v1/signer/publishers/${encodeURIComponent(handle)}`, {
      state,
      ...(suspend ? { reason: suspend } : {}),
    }),
  );
  return print(args, args.flags.json ? { ok: true, state } : `${handle} is ${state}.`);
}

async function blockCommand(verb: string, args: Args): Promise<void> {
  validateArgs(args, ["url", "key", "reason"], 3, 3);
  const subject = args.words[2] ?? "";
  const reason = needed(args, "reason", "Say why with --reason; publishers and devices show it");
  let change: BlocklistChange;
  if (verb === "block-pattern") {
    if (subject.length < 6) throw new CliFailure("refused", "A pattern is at least 6 characters");
    change = { kind: "pattern", text: subject, reason };
  } else {
    if (!/^[a-f0-9]{64}$/.test(subject))
      throw new CliFailure("refused", "Name it by its 64-digit sha256");
    change =
      verb === "block"
        ? { kind: "hash", hash: subject, reason }
        : { kind: "file", sha256: subject, reason };
  }
  const key = await readKey(option(args, "key"));
  succeeded(
    await signBlocklistChange(signerIo(marketUrl(args)), key, now, trustedWith(key), change),
  );
  return print(args, args.flags.json ? { ok: true } : "The blocklist is signed and stored.");
}

async function appealsCommand(args: Args): Promise<void> {
  validateArgs(args, ["url"], 2, 2);
  const { appeals } = await readQueue(signerIo(marketUrl(args)));
  if (args.flags.json) return print(args, appeals);
  const lines = queueSentences({ held: [], listings: [], verifications: [], appeals });
  return print(args, appeals.length > 0 ? lines.join("\n") : "No appeals wait.");
}

async function appealCommand(args: Args): Promise<void> {
  validateArgs(args, ["url", "answer", "approve", "keep"], 3, 3);
  const answer = needed(args, "answer", "Answer the publisher with --answer");
  if ((args.flags.approve === true) === (args.flags.keep === true))
    throw new CliFailure("refused", "Pass one of --approve or --keep");
  const decision = args.flags.approve === true ? "approve" : "keep";
  succeeded(
    await signerIo(marketUrl(args)).put(
      `/v1/signer/appeals/${encodeURIComponent(args.words[2] ?? "")}`,
      { answer, decision },
    ),
  );
  return print(
    args,
    args.flags.json
      ? { ok: true, decision }
      : `Appeal ${args.words[2]}: ${decision === "approve" ? "approved" : "kept"}.`,
  );
}

async function verifyCommand(verb: string, args: Args): Promise<void> {
  validateArgs(args, ["url", "key", "reason"], 3, 3);
  const handle = args.words[2] ?? "";
  const reason = needed(args, "reason", "Say why with --reason");
  const key = await readKey(option(args, "key"));
  succeeded(
    await signVerifiedChange(signerIo(marketUrl(args)), key, now, trustedWith(key), {
      handle,
      verified: verb === "verify",
      reason,
    }),
  );
  return print(
    args,
    args.flags.json
      ? { ok: true }
      : `${handle} is ${verb === "verify" ? "verified" : "no longer verified"}.`,
  );
}

const newPublisherId = () =>
  `pub_${[...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

async function officialCommand(args: Args): Promise<void> {
  validateArgs(args, ["url", "key"], 4, 4);
  const action = args.words[2];
  if (action !== "add" && action !== "remove")
    throw new CliFailure("refused", "Use ace market official add|remove ACCOUNT");
  const account = args.words[3] ?? "";
  const key = await readKey(option(args, "key"));
  succeeded(
    await signOfficialChange(
      signerIo(marketUrl(args)),
      key,
      now,
      trustedWith(key),
      { account, add: action === "add" },
      newPublisherId,
    ),
  );
  return print(
    args,
    args.flags.json
      ? { ok: true }
      : `${account} is ${action === "add" ? "on" : "off"} the official list.`,
  );
}

async function maintainerCommand(verb: string | undefined, args: Args): Promise<void> {
  switch (verb) {
    case "reports":
      return reportsCommand(args);
    case "collection":
      return collectionCommand(args);
    case "publisher":
      return publisherCommand(args);
    case "block":
    case "block-file":
    case "block-pattern":
      return blockCommand(verb, args);
    case "appeals":
      return appealsCommand(args);
    case "appeal":
      return appealCommand(args);
    case "verify":
    case "unverify":
      return verifyCommand(verb, args);
    case "official":
      return officialCommand(args);
    default:
      throw new CliFailure(
        "refused",
        "Use ace market keygen, sign, review, feature, revoke, reports, collection, publisher, block, appeals, appeal, verify or official. See ace --help.",
      );
  }
}
