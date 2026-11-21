import { z } from "zod";
import {
  MarketEntryName,
  MarketEntryType,
  MarketQueueBody,
  MarketReportsBody,
  MarketDiscoverBody,
  MarketReportState,
  MarketTermsNotice,
  type MarketCollection,
} from "@ace/protocol/marketplace";
import {
  findingSentence,
  signBlocklistChange,
  signNoticeChange,
  signOfficialChange,
  signReview,
  signVerifiedChange,
  signWithdrawAll,
  type BlocklistChange,
  type SignerIo,
} from "@ace/marketplace/signer";
import { option, validateArgs, type Args } from "../args.ts";
import { print } from "../io.ts";
import { CliFailure } from "../output.ts";
import { marketUrl, now, readKey, signerIo, trustedWith } from "./maintainer-io.ts";

/* The maintainers' queue work: reviews, reports, collections, publishers, blocks, appeals. */

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
  validateArgs(
    args,
    ["key", "url", "dev-market", "by-ace", "not-reviewed", "show", "approve", "block"],
    2,
    3,
  );
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
    validateArgs(args, ["url", "dev-market", "state", "note"], 4, 4);
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
  validateArgs(args, ["url", "dev-market"], 2, 2);
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
    validateArgs(args, ["url", "dev-market"], 3, 3);
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
    validateArgs(args, ["url", "dev-market", "title", "line"], 5, 28);
    const collection: MarketCollection = {
      id,
      title: needed(args, "title", "Give the collection a --title"),
      line: option(args, "line") ?? "",
      entries: args.words.slice(4).map(entryTarget),
    };
    const at = current.findIndex((item) => item.id === id);
    next = at === -1 ? [...current, collection] : current.with(at, collection);
  } else if (action === "remove") {
    validateArgs(args, ["url", "dev-market"], 4, 4);
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
  validateArgs(args, ["url", "dev-market", "key", "suspend", "restore", "withdraw-all"], 3, 3);
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
  validateArgs(args, ["url", "dev-market", "key", "reason"], 3, 3);
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
  validateArgs(args, ["url", "dev-market"], 2, 2);
  const { appeals } = await readQueue(signerIo(marketUrl(args)));
  if (args.flags.json) return print(args, appeals);
  const lines = queueSentences({ held: [], listings: [], verifications: [], appeals });
  return print(args, appeals.length > 0 ? lines.join("\n") : "No appeals wait.");
}

async function appealCommand(args: Args): Promise<void> {
  validateArgs(args, ["url", "dev-market", "answer", "approve", "keep"], 3, 3);
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
  validateArgs(args, ["url", "dev-market", "key", "reason"], 3, 3);
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
  validateArgs(args, ["url", "dev-market", "key"], 4, 4);
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

/** Signs a subscription's terms status into the notices devices read (ADR 0205 §4). */
async function noticeCommand(args: Args): Promise<void> {
  validateArgs(args, ["url", "dev-market", "key", "note"], 4, 4);
  const notice = MarketTermsNotice.omit({ at: true }).safeParse({
    provider: args.words[2],
    status: args.words[3],
    note: option(args, "note") ?? "",
  });
  if (!notice.success)
    throw new CliFailure(
      "refused",
      "Use ace market maintainer notice PROVIDER allowed|unclear|refused --note TEXT (at most 500 characters)",
    );
  const key = await readKey(option(args, "key"));
  succeeded(
    await signNoticeChange(signerIo(marketUrl(args)), key, now, trustedWith(key), notice.data),
  );
  return print(
    args,
    args.flags.json
      ? { ok: true }
      : `${notice.data.provider}'s terms read ${notice.data.status} in the signed notices. Devices only let a notice tighten what their build ships.`,
  );
}

export async function maintainerWork(verb: string | undefined, args: Args): Promise<void> {
  switch (verb) {
    case "review":
      return reviewCommand(args);
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
    case "notice":
      return noticeCommand(args);
    default:
      throw new CliFailure(
        "refused",
        "Use ace market maintainer keygen, sign, review, feature, revoke, reports, collection, publisher, block, appeals, appeal, verify, official or notice. See ace help market-maintainer.",
      );
  }
}
