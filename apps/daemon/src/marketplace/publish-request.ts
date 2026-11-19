import {
  MarketPickType,
  type MarketMe,
  type MarketPublishAction,
  type MarketResult,
} from "@ace/protocol/marketplace";
import { checkDraft, confirmedArchive } from "./check.ts";
import type { MarketHttp } from "./http.ts";
import type { SuitPort } from "./install.ts";
import { marketError as error } from "./market-error.ts";
import type { PickPorts } from "./pick.ts";
import { Refused } from "./prepare.ts";
import { publishAction, type MarketGrantPort } from "./publish.ts";

/*
 * One `publish` request as the service runs it: a draft from something picked or a folder is
 * checked on this machine before `publish.ts` sends anything to the market.
 */

/** Draft sources read and checked on this machine before anything is uploaded. */
const checkedKinds: ReadonlySet<string> = new Set([
  "folder",
  "spade-bot",
  "spade-skill",
  "ace-skill",
  "plugin",
]);

export interface PublishRequestPorts {
  http: MarketHttp | undefined;
  grant: MarketGrantPort | undefined;
  /** A person's market grant for a sensitive action's one call (ADR 0190). */
  personGrant?: string | undefined;
  /** The picker's ports, built only when a draft is checked here. */
  pick: () => PickPorts | undefined;
  suits: () => SuitPort | undefined;
}

type Drafting = Extract<
  MarketPublishAction,
  { action: "draftCheck" | "draftCreate" | "draftUpdate" }
>;

/**
 * One publish action. A draft from something picked or a folder is checked on this machine
 * first (`draftCheck`), and created only from the archive the person's confirmation of that
 * check allows; nothing else of it reaches the market.
 */
export async function publishRequest(
  ports: PublishRequestPorts,
  request: MarketPublishAction,
): Promise<MarketResult> {
  const base = { http: ports.http, grant: ports.grant, personGrant: ports.personGrant };
  const drafting =
    request.action === "draftCheck" ||
    request.action === "draftCreate" ||
    request.action === "draftUpdate"
      ? request
      : undefined;
  const source = drafting?.source;
  if (!drafting || !source || !checkedKinds.has(source.kind))
    return publishAction(base, ownFolder(ports.suits, request));
  const pick = ports.pick();
  if (!pick) return error("unavailable", "Publishing isn't set up on this machine");
  // The publisher's page is asked for (minting a grant) only when it is needed, so a folder
  // that can't be published is refused before any grant.
  let asked: Promise<MarketMe> | undefined;
  let failed: MarketResult | undefined;
  const me = () =>
    (asked ??= publishAction(base, { action: "me" }).then((mine) => {
      if (mine.op === "publish" && mine.answer.kind === "me") return mine.answer.me;
      failed = mine.op === "error" ? mine : error("failed", "The market didn't answer who you are");
      throw new Refused("The market didn't answer who you are");
    }));
  try {
    return await checked(drafting, source, pick, base, me);
  } catch (thrown) {
    // Signed out or unreachable while asking who the publisher is: say that, as any action does.
    if (failed) return failed;
    throw thrown;
  }
}

async function checked(
  drafting: Drafting,
  source: NonNullable<Drafting["source"]>,
  pick: PickPorts,
  base: Parameters<typeof publishAction>[0],
  me: () => Promise<MarketMe>,
): Promise<MarketResult> {
  const draft =
    drafting.action === "draftUpdate"
      ? (await me()).drafts.find((each) => each.id === drafting.id)
      : drafting;
  if (!draft) return error("not_found", "There is no such draft");
  const type = MarketPickType.safeParse(draft.type);
  if (!type.success) return error("invalid", "Only a bot, a skill or a plugin is checked here");
  const input = { type: type.data, name: draft.name, source, me };
  if (drafting.action === "draftCheck") {
    const check = await checkDraft(pick, input);
    if (!check) return error("invalid", "There is nothing to check");
    return { op: "publish", answer: { kind: "checked", check } };
  }
  const archive = await confirmedArchive(pick, { ...input, checked: drafting.checked });
  return publishAction({ ...base, archive }, drafting);
}

/** A draft from one of the person's Suits names that Suit's folder on this machine. */
function ownFolder(
  suitsOf: () => SuitPort | undefined,
  action: MarketPublishAction,
): MarketPublishAction {
  if (!("source" in action) || action.source?.kind !== "suit") return action;
  const suits = suitsOf();
  if (!suits) throw new Refused("Suits aren't running on this machine", { code: "not_found" });
  return { ...action, source: { kind: "folder", path: suits.folder(action.source.id) } };
}
