import type { MarketResult, MarketReview, MarketReviewItem } from "@ace/protocol/marketplace";
import { faceForId, parseStoredBotFace } from "@ace/ui-core/bot-face";
import {
  canDoSentences,
  changeTitle,
  count,
  dateText,
  decidedEachTime,
  effectDefaults,
  effectWords,
  entryAction,
  findingRows,
  flaggedWord,
  installBlock,
  limitSentences,
  missingNeedsSentence,
  needDefaults,
  replacesLine,
  reviewAction,
  reviewFromLine,
  reviewHeading,
  runDetail,
  runTitle,
  sizeText,
  triggerWhen,
  typeWord,
} from "@ace/ui-core/market";
import { updateSentences } from "@ace/ui-core/spade-chat";
import { initialOf } from "./spade-group-rows.ts";
import { installedItem } from "./market-installed.ts";
import { entryRow, installedRow } from "./market-rows.ts";

/*
 * An entry's page and its review on the phone (spec items 8 to 17): the one action, what it may
 * do, the review's sections by type with their switches as the daemon starts them, the review's
 * pages as rows, and the install's answer, with their words written. Pure.
 */

type Result<T extends MarketResult["op"]> = Extract<MarketResult, { op: T }>;
type Bot = Extract<MarketReview["body"], { type: "spade-bot" }>;

const actionWords = { install: "Get", update: "Update", installed: "Installed", none: null };

const hostOf = (from: string | undefined) =>
  from ? from.replace(/^https:\/\//, "") : "store.acehq.dev";

export function entryAnswer(result: Result<"read">) {
  const { entry } = result;
  const { summary } = entry;
  const action = entryAction(entry);
  const installed = entry.installed;
  // Remove and Turn back on ask in Installed's words, so both places say the same thing.
  const item = installed ? installedItem(installed) : undefined;
  return {
    entry: {
      ...entryRow(summary),
      description: entry.description,
      action,
      actionWord: actionWords[action],
      block: installBlock(entry) ?? null,
      publisherMark: summary.byAce ? "By ace" : summary.verified ? "Verified" : null,
      reviewMark: summary.reviewed ? "Reviewed by ace" : "Not reviewed by ace",
      sourceText: hostOf(summary.from),
      downloadsText: count(summary.downloads, "download"),
      versions: entry.versions.map((version) => ({
        version: version.version,
        date: dateText(version.published),
        size: sizeText(version.size),
        withdrawn: version.withdrawn ?? null,
      })),
      installed: installed ? installedRow(installed) : null,
      // The phone doesn't wear Suits; the sheet says where it landed first.
      installedNote:
        installed && summary.type === "suit" ? "Wear it from ace on your computer." : null,
      removeQuestion: item?.removeQuestion ?? null,
      removeLine: item?.removeDetail ?? null,
      turnOnWord: item?.turnOnWord ?? null,
      /** A withdrawn entry comes back only through this question. */
      turnOnAsk: item?.turnOnAsk ?? null,
    },
  };
}

function botSection(review: MarketReview, body: Bot) {
  const triggered = (body.triggers ?? []).flatMap((trigger) => {
    const when = triggerWhen(trigger);
    return when && "name" in trigger ? [{ name: trigger.name, when }] : [];
  });
  const update = body.update ? updateSentences(body.update, body.effects ?? []) : null;
  return {
    face: {
      main: false,
      initial: initialOf(body.botName),
      away: false,
      character: parseStoredBotFace(body.face)?.face ?? faceForId(review.name),
    },
    task: body.task,
    modelWord: body.model === "capable" ? "Capable model" : "Fast model",
    modelWarning: body.modelWarning ?? null,
    routines: [
      ...body.routines.map((routine) => ({ name: routine.name, when: routine.schedule })),
      ...triggered,
    ],
    brings: body.brings.map((item) => `${typeWord(item.type)} ${item.name} ${item.version}`),
    needs: body.needs.map((need) => ({
      key: need.key,
      label: need.label,
      line: `${need.why} ${need.required ? "Required." : "Optional."}`,
      required: need.required,
      offSentence: need.required
        ? (missingNeedsSentence(review.title, [need.label]) ?? null)
        : null,
    })),
    effects: body.linked
      ? (body.effects ?? []).map((row) => ({
          key: row.key,
          words: effectWords(row),
          why: `${row.why}${decidedEachTime(row) ? " You decide each time." : ""}`,
        }))
      : [],
    code: body.linked
      ? (body.code ?? []).map((row) => ({
          key: `code:${row.name}`,
          sentence: row.sentence,
          why: row.why,
        }))
      : [],
    update: update && {
      ...update,
      replay: body.update?.replay?.cases.length ? body.update.replay.summary : null,
    },
  };
}

/** What Install sends when the person changes nothing: needs as started, nothing else on. */
export function defaultChoices(review: MarketReview) {
  const body = review.body;
  if (body.type !== "spade-bot") return { bots: [], needs: {}, startRoutines: false };
  return {
    bots: [],
    needs: needDefaults(body.needs),
    startRoutines: false,
    ...(body.linked ? { effects: effectDefaults(body, review.byAce) } : {}),
  };
}

function reviewView(review: MarketReview) {
  const body = review.body;
  const recipe = body.type === "spade-bot" ? body : undefined;
  const moving = recipe?.update !== undefined;
  const action = reviewAction(review);
  const marked = review.reviewed || review.byAce;
  return {
    id: review.id,
    hash: review.hash,
    type: review.type,
    name: review.name,
    title: review.title,
    version: review.version,
    heading: reviewHeading(review),
    action,
    pendingWord: { Get: "Getting…", Update: "Updating…", "Roll back": "Rolling back…" }[action],
    byLine: [typeWord(review.type), review.publisher?.name, review.version]
      .filter(Boolean)
      .join(" · "),
    publisher: review.publisher?.name ?? null,
    signed: review.signed,
    signedText: review.signed ? "Signed by the Store" : "Not signed",
    reviewed: review.reviewed,
    reviewMark: marked ? "Reviewed by ace" : "Not reviewed by ace",
    reviewNote: marked ? null : "Read what it does before you install it.",
    updates: review.updates ?? null,
    canDo: canDoSentences(review),
    facts: [
      reviewFromLine(review),
      ...[replacesLine(review)].filter((line) => line !== undefined),
      ...(moving ? [] : canDoSentences(review)),
      ...(recipe && !moving ? limitSentences(recipe) : []),
      ...(review.deprecated ? [`Its publisher deprecated this version: ${review.deprecated}`] : []),
    ],
    findings: findingRows(review.scan),
    blocked: review.blocked ?? null,
    needs: recipe ? needDefaults(recipe.needs) : {},
    items: review.items,
    // Shown when an install is refused for the person's standing, which any type can need (a
    // skill with scripts too) and the phone can't prove yet (#2499).
    standingSentence: "Install this from your computer.",
    suit:
      body.type === "suit"
        ? {
            passes: body.passes,
            checkLine: canDoSentences(review)[0] ?? "",
            problems: body.problems.map((problem) =>
              problem.path ? `${problem.path}: ${problem.message}` : problem.message,
            ),
            scenes: body.scenes,
          }
        : null,
    plugin: body.type === "spade-plugin" ? { asksBots: true } : null,
    bot: recipe ? botSection(review, recipe) : null,
    choices: defaultChoices(review),
  };
}

export function reviewAnswer(result: Result<"review">) {
  return { review: reviewView(result.review) };
}

/** A page's row as the sheet lists it: a text shown whole, a file, a run, a change or a note. */
function itemRow(item: MarketReviewItem, index: number) {
  const id = `${index}`;
  switch (item.kind) {
    case "text":
      return {
        id,
        kind: "text",
        section: item.section,
        title: item.before ? `${item.path} before` : item.path,
        text: item.text,
        detail: item.truncated ? "Cut short here; the rest is on your computer." : null,
        flagged: false,
      };
    case "file": {
      const flag = flaggedWord(item.file);
      return {
        id,
        kind: "file",
        section: item.section,
        title: item.file.path,
        text: null,
        detail: [sizeText(item.file.bytes), flag].filter(Boolean).join(" · "),
        flagged: item.file.executable || item.file.flagged,
      };
    }
    case "execution":
      return {
        id,
        kind: "run",
        section: item.section,
        title: runTitle(item.execution),
        text: null,
        detail: runDetail(item.execution),
        flagged: true,
      };
    case "change":
      return {
        id,
        kind: "change",
        section: item.section,
        title: changeTitle(item),
        text: null,
        detail: item.executable ? "A script or program" : null,
        flagged: item.executable,
      };
    case "note":
      return {
        id,
        kind: "note",
        section: item.section,
        title: item.text,
        text: null,
        detail: null,
        flagged: false,
      };
  }
}

export function reviewPageAnswer(result: Result<"reviewPage">, offset: number) {
  return {
    review: reviewView(result.review),
    rows: result.items.map((item, index) => itemRow(item, offset + index)),
    nextOffset: result.nextOffset ?? null,
    complete: result.nextOffset === undefined,
  };
}

/** Install and cancel answer `done`; an install names what landed. */
export function doneAnswer(result: Result<"done">) {
  return { installed: result.installed ? installedRow(result.installed) : null };
}
