import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { acceptCheck } from "@ace/mcp-server/market-verbs";
import {
  MarketEntryType,
  MarketVersion,
  type MarketDraft,
  type MarketDraftCheck,
  type MarketDraftSource,
  type MarketPublishAnswer,
} from "@ace/protocol/marketplace";
import { CliFailure, usageFailure } from "../output.ts";
import { checkFolder, problemLine } from "./check.ts";
import { answerOf, type MarketAsk } from "./request.ts";

/*
 * `ace market publish TYPE PATH|ID` step by step (ADR 0178 §12.2): the local checks first, then
 * what would upload (checked here), the draft and its scan, the confirmation, and the publish.
 * `--wait` watches until the version is live or not reviewed (exit 0) or blocked (exit 1).
 */

export interface PublishRequest {
  readonly type: string;
  readonly target: string;
  readonly name?: string | undefined;
  readonly version?: string | undefined;
  readonly changelog?: string | undefined;
}

/** How confirmations are answered: a person at a terminal, `--yes`, or nobody. */
export interface PublishConsent {
  /** May the check's flagged texts and binary files go public? */
  findings(check: MarketDraftCheck): Promise<boolean>;
  /** Publish this draft now? False keeps it as a draft. */
  publish(draft: MarketDraft): Promise<boolean>;
}

const draftOf = (answer: MarketPublishAnswer): MarketDraft => {
  if (answer.kind !== "draft")
    throw new CliFailure("failed", `The market answered ${answer.kind}, not a draft.`);
  return answer.draft;
};

/** Where the files come from: a folder on this machine, or one of the person's Suits. */
async function sourceOf(type: MarketEntryType, target: string): Promise<MarketDraftSource> {
  const folder = await stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (folder) return { kind: "folder", path: resolve(target) };
  if (type === "suit") return { kind: "suit", id: target };
  throw usageFailure(`${target} isn't a folder.`, {
    argument: "PATH",
    hint: "Pass the entry's folder; a Suit may also be named by its id.",
  });
}

/** Uploads the draft; the confirmation and the publish come after. */
export async function createDraft(
  ask: MarketAsk,
  request: PublishRequest,
  consent: PublishConsent,
): Promise<MarketDraft> {
  const type = MarketEntryType.safeParse(request.type);
  if (!type.success)
    throw usageFailure(`${request.type} isn't a market type.`, {
      argument: "TYPE",
      hint: "suit, spade-skill, spade-plugin or spade-bot.",
    });
  const source = await sourceOf(type.data, request.target);
  let name = request.name ?? request.target;
  if (source.kind === "folder") {
    const checked = await checkFolder(source.path, { type: type.data, name: request.name });
    name = checked.name;
    if (checked.problems.length > 0)
      throw new CliFailure(
        "failed",
        `${type.data}/${name} has ${checked.problems.length} problem${checked.problems.length === 1 ? "" : "s"} to fix before publishing: ${checked.problems.map((problem) => problemLine(problem, name)).join("; ")}`,
        checked,
        { code: "check_failed", problems: checked.problems },
      );
  }
  if (!request.version || !MarketVersion.safeParse(request.version).success)
    throw usageFailure(
      request.version ? `${request.version} isn't a version.` : "Name the version to publish.",
      { code: "missing_argument", argument: "--version", hint: "Pass --version 1.2.0." },
    );
  let checked: ReturnType<typeof acceptCheck> | undefined;
  if (source.kind === "folder") {
    const answer = answerOf(
      await ask({
        op: "publish",
        request: { action: "draftCheck", type: type.data, name, source },
      }),
      "publish",
    ).answer;
    if (answer.kind !== "checked") throw new CliFailure("failed", "The check didn't come back.");
    const { check } = answer;
    const blocking = check.findings.find((finding) => finding.blocking);
    if (blocking)
      throw new CliFailure("failed", blocking.sentence, check, {
        code: "check_failed",
        problems: [
          {
            path: blocking.path,
            ...(blocking.line ? { line: blocking.line } : {}),
            message: blocking.sentence,
          },
        ],
      });
    const binaries = check.files.some((file) => file.binary);
    if ((check.findings.length > 0 || binaries) && !(await consent.findings(check)))
      throw new CliFailure(
        "needs-human",
        "What would upload has texts or files to confirm before they go public.",
        check,
        {
          code: "confirm",
          hint: "Read them, fix the files, or run it again with --yes to publish them as they are.",
          problems: check.findings.map((finding) => ({
            path: finding.path,
            ...(finding.line ? { line: finding.line } : {}),
            message: finding.sentence,
          })),
        },
      );
    checked = acceptCheck(check);
  }
  const created = answerOf(
    await ask({
      op: "publish",
      request: {
        action: "draftCreate",
        type: type.data,
        name,
        version: request.version,
        source,
        ...(request.changelog ? { changelog: request.changelog } : {}),
        ...(checked ? { checked } : {}),
      },
    }),
    "publish",
  );
  return draftOf(created.answer);
}

/** The confirmation's question (ADR 0178 §12.2 step 4). */
export function publishQuestion(draft: MarketDraft, unlisted: boolean): string {
  const notes = draft.scan?.state === "done" ? draft.scan.report.findings.length : 0;
  return `Publish ${draft.type}/${draft.name} ${draft.version}? ${unlisted ? "Unlisted" : "Listed"}, ${draft.files} files, ${Math.ceil(draft.size / 1024)} KB. ${notes ? `The scan found ${notes} note${notes === 1 ? "" : "s"}.` : "The scan found nothing."}`;
}

/** Publishes a draft, after the confirmation; false from the consent keeps it as a draft. */
export async function publishDraft(
  ask: MarketAsk,
  draft: MarketDraft,
  consent: PublishConsent,
  unlisted: boolean,
): Promise<MarketPublishAnswer | undefined> {
  if (!(await consent.publish(draft))) return undefined;
  const { answer } = answerOf(
    await ask({ op: "publish", request: { action: "draftPublish", id: draft.id } }),
    "publish",
  );
  if (unlisted)
    await ask({
      op: "publish",
      request: { action: "visibility", type: draft.type, name: draft.name, visibility: "unlisted" },
    });
  return answer;
}

/** Watches a published version until it settles: live or not reviewed, or blocked. */
export async function waitForVersion(
  ask: MarketAsk,
  key: { type: MarketEntryType; name: string; version: string },
  deps: { sleep(ms: number): Promise<void>; deadline: number; now(): number },
): Promise<"live" | "not-reviewed" | "blocked" | "withdrawn" | "waiting"> {
  for (;;) {
    const { answer } = answerOf(
      await ask({ op: "publish", request: { action: "entry", type: key.type, name: key.name } }),
      "publish",
    );
    const status =
      answer.kind === "entry"
        ? answer.entry.versions.find((each) => each.version === key.version)?.status
        : undefined;
    if (status && status !== "waiting") return status;
    if (deps.now() >= deps.deadline) return "waiting";
    await deps.sleep(5000);
  }
}
