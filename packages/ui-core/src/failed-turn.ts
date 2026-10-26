import type { Item, ProviderKind } from "@ace/protocol";
import { describeProviderError, isLimitError, type ErrorView } from "./error-display.ts";
import { modelLabel } from "./providers.ts";
import { displayNotice } from "./notice-text.ts";
import { noticeError } from "./notice-error.ts";

/*
 * A failed turn as one row, on every client: the failure in words from the notice that reported
 * it, else from the run, else from the agent while the turn was its latest; the action that
 * fixes it (sign in, another account, another model) on the newest turn; the provider's own text
 * behind Details, never the same words again. Pure.
 */

/** Whether the provider's text says only what the row already says, perhaps after a label. */
function repeats(raw: string, shown: { title: string; message?: string | undefined }): boolean {
  const text = raw.trim();
  return [shown.message, shown.title].some(
    (said) => !!said && (text === said || text.endsWith(`: ${said}`)),
  );
}

/** Actions that fix the failure where it is; Retry would only fail again. */
const fixes = new Set(["sign_in", "switch_account", "change_model"]);

export interface FailedTurnInput {
  /** The notice that reported the failure, when the turn has one. */
  notice: Item | undefined;
  /** The run's own failure, or the one seen on its agent while the turn was its latest. */
  error: { kind: string; message: string } | undefined;
  provider: ProviderKind | undefined;
  /** The model the turn ran on, when known. */
  model: string | undefined;
  /** The thread's newest turn: only it offers a fix or Retry. */
  latest: boolean;
  /** The queue holds the turn for ace's Continue, which its stop's pill offers instead of Retry. */
  held?: boolean | undefined;
}

export interface FailedTurnView {
  error: ErrorView;
  /** "Turn failed", with the failure's words after it; none when a fix names the failure. */
  heading: string | undefined;
  /** The failure is fixed by its action (sign in, another account, another model), not Retry. */
  fixable: boolean;
  /** A usage or rate limit: the composer's strip says it, not the transcript. */
  limit: boolean;
  /** Whether the row offers Retry: the newest turn, with no fix and no Continue for it already. */
  retry: boolean;
}

export function failedTurnView(input: FailedTurnInput): FailedTurnView {
  const { error, latest, provider, model } = input;
  const notice = input.notice?.type === "notice" ? input.notice : undefined;
  const original = notice ? noticeError(notice) : undefined;
  const display = notice ? displayNotice(notice) : undefined;
  const reported = original
    ? {
        ...original,
        text: display?.text ?? "",
        title: display?.title,
        code: display?.code,
        detail: display?.detail,
      }
    : undefined;
  const described = describeProviderError(
    reported
      ? { ...reported, provider: reported.provider ?? provider, model: reported.model ?? model }
      : {
          text: error?.message ?? "",
          kind: error?.kind,
          provider,
          model,
          // Details names the failure's kind as the daemon reported it.
          detail: error ? `${error.kind}: ${error.message}` : undefined,
        },
  );
  // Native tagged text must not classify or replace the diagnostic's reviewed wording. Details
  // only says what the summary doesn't: never the same words again ("provider: " before them).
  const raw = original ? (original.detail ?? original.text) : described.raw;
  const view = { ...described, raw: raw && !repeats(raw, described) ? raw : undefined };
  const limit = isLimitError(view);
  const fixable = latest && view.action !== undefined && fixes.has(view.action);
  // Nothing said why: "Turn failed" alone. A fix names the failure itself ("Not signed in").
  const known = reported !== undefined || error !== undefined;
  // A limit names itself ("Usage limit reached · Resets 8:30pm"), never "Turn failed".
  const heading = fixable || !known || limit ? undefined : "Turn failed";
  // Under "Turn failed" the failure's own words follow the model, even when they were its title.
  const said = heading ? (view.message ?? view.title) : view.message;
  const failed: ErrorView = known
    ? {
        ...view,
        message:
          [model && view.code !== "model_not_found" ? modelLabel(model) : undefined, said]
            .filter(Boolean)
            .join(" · ") || undefined,
      }
    : { title: "Turn failed" };
  return {
    error: fixable ? failed : { ...failed, action: undefined },
    heading,
    fixable,
    limit,
    retry: latest && !fixable && input.held !== true,
  };
}

/**
 * The row's words as `ErrorRow` draws them: the heading or the failure's title, the message
 * after it, and Details only when it says something the row doesn't.
 */
export function errorRowText(
  view: ErrorView,
  heading?: string,
): {
  title: string;
  message: string | undefined;
  details: string | undefined;
} {
  const title = heading ?? view.title;
  const message = heading ? (view.message ?? view.title) : view.message;
  const details = view.raw && view.raw !== title && view.raw !== message ? view.raw : undefined;
  return { title, message, details };
}
