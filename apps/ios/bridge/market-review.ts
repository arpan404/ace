import type { MarketResult, MarketReview, MarketReviewItem } from "@ace/protocol/marketplace";
import {
  canDoSentences,
  count,
  dateText,
  entryAction,
  findingSentences,
  flaggedWord,
  installBlock,
  needDefaults,
  sizeText,
} from "@ace/ui-core/market";
import { entryRow, installedRow } from "./market-rows.ts";

/*
 * An entry's page and its review on the phone (spec items 8 to 13): the one action, what it may
 * do, the review's pages and the install's answer, with their words written. Pure. Slice #2501
 * shapes these further.
 */

type Result<T extends MarketResult["op"]> = Extract<MarketResult, { op: T }>;

const actionWords = { install: "Get", update: "Update", installed: "Installed", none: null };

export function entryAnswer(result: Result<"read">) {
  const { entry } = result;
  const action = entryAction(entry);
  return {
    entry: {
      ...entryRow(entry.summary),
      description: entry.description,
      action,
      actionWord: actionWords[action],
      block: installBlock(entry) ?? null,
      downloadsText: count(entry.summary.downloads, "download"),
      versions: entry.versions.map((version) => ({
        version: version.version,
        date: dateText(version.published),
        size: sizeText(version.size),
        withdrawn: version.withdrawn ?? null,
      })),
      installed: entry.installed ? installedRow(entry.installed) : null,
    },
  };
}

function reviewView(review: MarketReview) {
  const needs = review.body.type === "spade-bot" ? (review.body.needs ?? []) : [];
  return {
    id: review.id,
    hash: review.hash,
    type: review.type,
    name: review.name,
    title: review.title,
    version: review.version,
    publisher: review.publisher?.name ?? null,
    signed: review.signed,
    reviewed: review.reviewed,
    reviewMark: review.reviewed ? "Reviewed by ace" : "Not reviewed by ace",
    updates: review.updates ?? null,
    canDo: canDoSentences(review),
    findings: findingSentences(review.scan),
    blocked: review.blocked ?? null,
    needs: needDefaults(needs),
    items: review.items,
  };
}

export function reviewAnswer(result: Result<"review">) {
  return { review: reviewView(result.review) };
}

function itemRow(item: MarketReviewItem) {
  if (item.kind !== "file") return item;
  return {
    ...item,
    size: sizeText(item.file.bytes),
    flag: flaggedWord(item.file) ?? null,
  };
}

export function reviewPageAnswer(result: Result<"reviewPage">) {
  return {
    review: reviewView(result.review),
    items: result.items.map(itemRow),
    nextOffset: result.nextOffset ?? null,
  };
}

/** Install and cancel answer `done`; an install names what landed. */
export function doneAnswer(result: Result<"done">) {
  return { installed: result.installed ? installedRow(result.installed) : null };
}
