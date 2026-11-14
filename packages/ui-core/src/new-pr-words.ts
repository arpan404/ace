import { actionErrorText } from "./action-errors.ts";

/*
 * The New pull request page's words, shared by the web and the phone: a milestone's due date,
 * and what a create that GitHub only partly took says. Pure.
 */

/**
 * "Due Nov 20, 2026", or null with no due date. GitHub keeps a due date as midnight UTC, so the
 * day is read in UTC: elsewhere it would show the day before.
 */
export function milestoneDue(dueOn: string | null, locale?: string): string | null {
  if (!dueOn) return null;
  const at = Date.parse(dueOn);
  if (Number.isNaN(at)) return null;
  const day = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
  return `Due ${day}`;
}

/**
 * What the person hears after a create: the pull request the branches already had, or one
 * opened without all of its reviewers, labels, assignees or milestone (`code`, a warning).
 * Nothing for a clean create.
 */
export function prCreateNotice(result: {
  number: number;
  existing: boolean;
  code: string | undefined;
}): { title: string; detail: string | null; warning: boolean } | undefined {
  if (result.existing)
    return {
      title: `This branch already has pull request #${result.number}`,
      detail: null,
      warning: false,
    };
  if (result.code)
    return {
      title: `Opened pull request #${result.number}`,
      detail: actionErrorText(result.code),
      warning: true,
    };
  return undefined;
}
